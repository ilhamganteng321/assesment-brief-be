import { setDefaultTimeout } from "bun:test";

import { app } from "../../src/app";
import { localStorageProvider } from "../../src/modules/attachments/storage/local.storage";
import { hashPassword } from "../../src/modules/auth/password";
import { db } from "../../src/prisma/db";
import { toVarchar, type StoredTimestamp } from "../../src/prisma/scalars";

// ---------------------------------------------------------------------------
// Shared harness for the DB-backed suites under `tests/`.
//
// These suites drive the real application through `app.request()` against a
// live PostgreSQL database, exactly like `src/integration/assessment.integration.ts`.
// Nothing here re-implements a business rule: every assertion goes through the
// HTTP surface, so a rule can only pass if the deployed service enforces it.
//
// Direct database access is confined to two places, both of them test
// scaffolding rather than a second copy of the domain:
//   * creating the PM and Client actors, which `/auth/register` deliberately
//     refuses to do (it only ever creates INTERNAL accounts);
//   * reading rows back to prove what was actually persisted, and removing the
//     records the suite created.
//
// Run with:  bun run test:suites
// ---------------------------------------------------------------------------

/**
 * Password hashing is deliberately expensive (bcrypt cost 12), so building a
 * three-actor world costs several seconds of real hashing. Bun's default 5s
 * timeout is not enough for a `beforeAll` that does it, and raising the
 * per-call timeout on every individual test would be noise. Importing this
 * module raises the ceiling for the whole suite instead.
 */
setDefaultTimeout(120_000);

export const TEST_PASSWORD = "ItPass#2026";

/** One run id per process keeps concurrent suites from colliding on emails. */
const RUN_ID = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;

/**
 * Which attempt at the shared world is currently being built.
 *
 * Part of the fixture identity on purpose: a retried attempt must not reuse an
 * email whose row the failed attempt already committed, or the retry collides on
 * the unique constraint and never gets a clean start.
 */
let worldAttempt = 0;

/** How many times a shared world may be rebuilt before the suite gives up. */
const WORLD_ATTEMPTS = 3;

/**
 * Backoff schedule for the initial reachability probe, in milliseconds.
 *
 * Sized for a managed PostgreSQL reached over the network. A hosted database
 * parks its compute when it goes idle, and the first connection after that has
 * to wait for it to resume; a pooler also sheds connections that have been open
 * too long. A previous suite finishing seconds earlier is therefore no guarantee
 * that this one can connect immediately, and a couple of quick retries turned
 * that into a spurious "database unreachable" failure. Roughly 20 seconds of
 * patience costs nothing when the database is healthy, and absorbs the resume
 * when it is not.
 */
const REACHABILITY_BACKOFF_MS = [250, 500, 1000, 2000, 3000, 4000, 5000] as const;

/** Pause between attempts at the shared world, after clearing the last one. */
const WORLD_RETRY_PAUSE_MS = 2000;

export const itEmail = (label: string): string =>
	`it-${label}-${RUN_ID}-${worldAttempt}@example.local`;

export type ApiResult = {
	readonly status: number;
	readonly json: unknown;
	readonly text: string;
	readonly bytes: Buffer;
	readonly headers: Headers;
};

export type ApiOptions = {
	readonly method?: string;
	readonly token?: string;
	readonly body?: unknown;
	/** Sent verbatim, so a caller can post deliberately malformed JSON. */
	readonly rawBody?: string;
	readonly form?: FormData;
	readonly headers?: Record<string, string>;
};

/** Issues a request against the in-process app and normalises the response. */
export async function api(
	path: string,
	options: ApiOptions = {},
): Promise<ApiResult> {
	const headers: Record<string, string> = { ...options.headers };
	if (options.token) {
		headers.Authorization = `Bearer ${options.token}`;
	}
	let body: string | FormData | undefined;
	if (options.body !== undefined) {
		headers["content-type"] = headers["content-type"] ?? "application/json";
		body = JSON.stringify(options.body);
	}
	if (options.rawBody !== undefined) {
		headers["content-type"] = headers["content-type"] ?? "application/json";
		body = options.rawBody;
	}
	if (options.form !== undefined) {
		body = options.form;
	}
	const response = await app.request(path, {
		method: options.method ?? "GET",
		headers,
		body,
	});
	const bytes = Buffer.from(await response.arrayBuffer());
	const text = bytes.toString("utf8");
	let json: unknown = null;
	try {
		json = JSON.parse(text);
	} catch {
		// Binary or HTML response; `json` stays null.
	}
	return { status: response.status, json, text, bytes, headers: response.headers };
}

/**
 * Anything carrying a parsed body. The suites narrow their own responses to a
 * small shape for readability, so the readers below take just the body.
 */
export type ResponseBody = { readonly json: unknown };

/**
 * A step into a response body: an object key, or a numeric array index.
 */
export type JsonPathStep = string | number;

/**
 * Reads a nested value out of a response body, or `undefined` if absent.
 *
 * The result type is stated by the caller rather than inferred, because there is
 * nothing in the arguments to infer it from. Leaving it off yields `unknown`,
 * which still compares fine in an assertion but quietly loses the check that the
 * field really has the shape the test assumes.
 */
export function jsonPath<T = unknown>(
	result: ResponseBody,
	path: readonly JsonPathStep[],
): T | undefined {
	let current: unknown = result.json;
	for (const key of path) {
		if (current === null || typeof current !== "object" || !(key in current)) {
			return undefined;
		}
		current = (current as Record<string, unknown>)[key];
	}
	return current as T;
}

/** The stable machine-readable error code, e.g. `TASK_NOT_FOUND`. */
export function errorCode(result: ResponseBody): string {
	return String(jsonPath(result, ["error", "code"]) ?? "");
}

export function errorMessage(result: ResponseBody): string {
	return String(jsonPath(result, ["error", "message"]) ?? "");
}

export function dataOf<T>(result: ApiResult): T {
	return jsonPath<T>(result, ["data"]) as T;
}

// ---------------------------------------------------------------------------
// Actor and project fixtures
// ---------------------------------------------------------------------------

export type Role = "PM" | "INTERNAL" | "CLIENT";
export type Department = "PRODUCT" | "UI_UX" | "FRONTEND" | "BACKEND";

export type Actor = {
	readonly role: Role;
	readonly userId: string;
	readonly email: string;
	readonly token: string;
};

const ownedUserIds: string[] = [];
const ownedProjectIds: string[] = [];
const ownedTaskIds: string[] = [];

/**
 * Registers a user straight through the API. Only ever yields INTERNAL.
 *
 * A registration that comes back without an identity is a broken fixture, not an
 * empty string to carry onwards. Returning `"User"` used to push the failure all
 * the way down the suite, where it surfaced as a `TypeError` about an unrelated
 * line; throwing here names the request that actually failed.
 */
export async function registerInternal(input: {
	name: string;
	email: string;
	department: Department;
}): Promise<Actor> {
	const res = await api("/auth/register", {
		method: "POST",
		body: {
			name: input.name,
			email: input.email,
			password: TEST_PASSWORD,
			department: input.department,
		},
	});
	const token = jsonPath<string>(res, ["data", "accessToken"]);
	const userId = jsonPath<string>(res, ["data", "user", "id"]);
	if (!userId || !token) {
		throw new Error(
			`fixture: registering ${input.email} failed (status=${res.status}, code=${errorCode(res)}, body=${res.text.slice(0, 300)})`,
		);
	}
	ownedUserIds.push(userId);
	return { role: "INTERNAL", userId, email: input.email, token };
}

/**
 * Creates a PM or Client actor directly in the database. `/auth/register`
 * intentionally only issues INTERNAL accounts, so there is no API path that can
 * produce these two roles, and the suites still need to exercise them.
 */
export async function createPrivilegedActor(input: {
	role: Role;
	email: string;
	department: Department;
}): Promise<Actor> {
	const user = await db.orm.public.Users.create({
		name: toVarchar<100>(`It ${input.role}`),
		email: toVarchar<255>(input.email),
		passwordHash: await hashPassword(TEST_PASSWORD),
		role: input.role,
		department: input.department,
	});
	ownedUserIds.push(user.id);
	const token = await loginOrThrow(input.email, TEST_PASSWORD);
	return { role: input.role, userId: user.id, email: input.email, token };
}

export async function login(email: string, password: string): Promise<string> {
	const res = await api("/auth/login", {
		method: "POST",
		body: { email, password },
	});
	return jsonPath<string>(res, ["data", "accessToken"]) ?? "";
}

/** Logs in and fails loudly, so a broken fixture cannot masquerade as a bug. */
export async function loginOrThrow(email: string, password: string): Promise<string> {
	const res = await api("/auth/login", {
		method: "POST",
		body: { email, password },
	});
	const token = jsonPath<string>(res, ["data", "accessToken"]);
	if (res.status !== 200 || typeof token !== "string") {
		throw new Error(
			`fixture: login failed for ${email} (status=${res.status}, body=${res.text.slice(0, 200)})`,
		);
	}
	return token;
}

export type Project = { readonly id: string; readonly name: string };

export async function createProject(
	actor: Actor,
	input: { name: string; clientName?: string },
): Promise<Project> {
	const res = await api("/projects", {
		method: "POST",
		token: actor.token,
		body: { name: input.name, clientName: input.clientName ?? "It Client Co" },
	});
	const id = jsonPath<string>(res, ["data", "project", "id"]) ?? "";
	if (id.length === 0) {
		throw new Error(
			`fixture: project creation failed (status=${res.status}, body=${res.text.slice(0, 300)})`,
		);
	}
	ownedProjectIds.push(id);
	return { id, name: input.name };
}

/**
 * Adds a member. The membership carries no role of its own: a member's
 * authority comes from the user record, so a CLIENT stays a CLIENT here.
 */
export async function addMember(
	pm: Actor,
	projectId: string,
	userId: string,
): Promise<ApiResult> {
	const res = await api(`/projects/${projectId}/members`, {
		method: "POST",
		token: pm.token,
		body: { userId },
	});
	if (res.status !== 201) {
		throw new Error(
			`fixture: adding member ${userId} failed (status=${res.status}, code=${errorCode(res)}, body=${res.text.slice(0, 200)})`,
		);
	}
	return res;
}

export type TaskOverrides = {
	description?: string;
	status?: "TODO" | "BLOCKED" | "IN_PROGRESS" | "DONE";
	priority?: "LOW" | "MEDIUM" | "HIGH" | "URGENT";
	department?: Department;
	assignedToId?: string;
	clientVisible?: boolean;
};

/** Creates a task and returns its id, throwing if the API refuses. */
export async function createTask(
	actor: Actor,
	projectId: string,
	title: string,
	overrides: TaskOverrides = {},
): Promise<string> {
	const res = await api("/tasks", {
		method: "POST",
		token: actor.token,
		body: { projectId, title, ...overrides },
	});
	const id = jsonPath<string>(res, ["data", "task", "id"]) ?? "";
	if (id.length === 0) {
		throw new Error(
			`fixture: task "${title}" creation failed (status=${res.status}, code=${errorCode(res)}, body=${res.text.slice(0, 300)})`,
		);
	}
	ownedTaskIds.push(id);
	return id;
}

/** Creates a task and returns the raw response, for negative-path fixtures. */
export async function tryCreateTask(
	actor: Actor,
	projectId: string,
	title: string,
	overrides: TaskOverrides = {},
): Promise<ApiResult> {
	const res = await api("/tasks", {
		method: "POST",
		token: actor.token,
		body: { projectId, title, ...overrides },
	});
	const id = jsonPath<string>(res, ["data", "task", "id"]);
	if (typeof id === "string" && id.length > 0) {
		ownedTaskIds.push(id);
	}
	return res;
}

export async function addDependency(
	actor: Actor,
	projectId: string,
	dependentTaskId: string,
	dependencyTaskId: string,
): Promise<ApiResult> {
	return api(`/projects/${projectId}/tasks/${dependentTaskId}/dependencies`, {
		method: "POST",
		token: actor.token,
		body: { dependencyTaskId },
	});
}

export type TaskRow = {
	readonly id: string;
	readonly projectId: string;
	readonly version: number;
	readonly status: string;
	readonly title: string;
	readonly description: string | null;
	readonly priority: string;
	readonly department: string;
	readonly clientVisible: boolean;
	readonly assignedToId: string | null;
	readonly deletedAt: StoredTimestamp | null;
};

/** Reads the stored row, to prove what the database actually holds. */
export async function readTaskRow(taskId: string): Promise<TaskRow | null> {
	const row = await db.orm.public.Tasks.where((t) => t.id.eq(taskId)).first();
	if (!row) {
		return null;
	}
	return {
		id: row.id,
		projectId: row.projectId,
		version: row.version,
		status: row.status,
		title: row.title,
		description: row.description,
		priority: row.priority,
		department: row.department,
		clientVisible: row.clientVisible,
		assignedToId: row.assignedToId,
		deletedAt: row.deletedAt,
	};
}

export async function readAuditRows(taskId: string): Promise<
	readonly {
		id: string;
		userId: string;
		changedColumn: string;
		oldValue: string | null;
		newValue: string | null;
	}[]
> {
	const rows = await db.orm.public.AuditLogs.where((a) => a.taskId.eq(taskId))
		.select("id", "userId", "changedColumn", "oldValue", "newValue")
		.all();
	return rows.map((row) => ({
		id: row.id,
		userId: row.userId,
		changedColumn: String(row.changedColumn),
		oldValue: row.oldValue,
		newValue: row.newValue,
	}));
}

/** Marks a task DONE for fixtures that need a satisfied prerequisite. */
export async function forceStatus(
	taskId: string,
	status: "TODO" | "BLOCKED" | "IN_PROGRESS" | "DONE",
): Promise<void> {
	await db.orm.public.Tasks.where((t) => t.id.eq(taskId)).update({ status });
}

const sleep = (ms: number): Promise<void> =>
	new Promise((resolve) => setTimeout(resolve, ms));

/** The most recent connection failure, quoted in the suite diagnostic. */
let lastConnectionError: string | null = null;

async function pingDatabase(): Promise<boolean> {
	try {
		await db.orm.public.Users.aggregate((aggregate) => ({
			total: aggregate.count(),
		}));
		lastConnectionError = null;
		return true;
	} catch (error) {
		lastConnectionError =
			error instanceof Error
				? (error.message.split("\n")[0] ?? error.message)
				: String(error);
		return false;
	}
}

/**
 * Whether the database answers, allowing for a managed instance to wake up.
 *
 * The suites talk to a real PostgreSQL over the network, so "cannot connect yet"
 * is an environmental blip rather than a verdict on the code under test. The
 * backoff schedule absorbs a cold compute. Everything after this point assumes a
 * working connection and does not retry, so a genuine fault still fails the suite
 * rather than being papered over, and an unreachable database still fails the
 * suite loudly instead of passing on an empty fixture.
 */
export async function databaseIsReachable(): Promise<boolean> {
	for (const backoffMs of REACHABILITY_BACKOFF_MS) {
		if (await pingDatabase()) {
			return true;
		}
		await sleep(backoffMs);
	}
	return false;
}

/**
 * Removes everything a suite created, child first. Every step is best-effort so
 * one failure cannot strand the rest of the graph.
 */
export async function cleanupFixtures(): Promise<void> {
	for (const taskId of ownedTaskIds) {
		try {
			const rows = await db.orm.public.Attachments.where((row) =>
				row.taskId.eq(taskId),
			)
				.select("id", "storageKey")
				.all();
			for (const row of rows) {
				try {
					await localStorageProvider.delete(row.storageKey);
				} catch {
					// best-effort: the blob may already be gone
				}
				try {
					await db.orm.public.Attachments.where((a) =>
						a.id.eq(row.id),
					).delete();
				} catch {
					// best-effort
				}
			}
		} catch {
			// best-effort
		}
	}

	if (ownedTaskIds.length > 0) {
		try {
			const dependencies = await db.orm.public.TaskDependencies.where((row) =>
				row.dependentTaskId.in(ownedTaskIds),
			).all();
			for (const row of dependencies) {
				try {
					await db.orm.public.TaskDependencies.where((d) =>
						d.id.eq(row.id),
					).delete();
				} catch {
					// best-effort
				}
			}
		} catch {
			// best-effort
		}
	}

	for (const taskId of ownedTaskIds) {
		try {
			await db.orm.public.Tasks.where((t) => t.id.eq(taskId)).delete();
		} catch {
			// best-effort
		}
	}

	for (const projectId of ownedProjectIds) {
		try {
			await db.orm.public.ProjectMembers.where((m) =>
				m.projectId.eq(projectId),
			).delete();
			await db.orm.public.Projects.where((p) => p.id.eq(projectId)).delete();
		} catch {
			// best-effort
		}
	}

	for (const userId of ownedUserIds) {
		try {
			await db.orm.public.Users.where((u) => u.id.eq(userId)).delete();
		} catch {
			// best-effort
		}
	}

	ownedUserIds.length = 0;
	ownedProjectIds.length = 0;
	ownedTaskIds.length = 0;
}

// ---------------------------------------------------------------------------
// A complete three-actor world: one PM, two engineers, one client guest, and two
// projects so cross-tenant access has somewhere to point.
// ---------------------------------------------------------------------------

export type World = {
	readonly pm: Actor;
	readonly engineer: Actor;
	readonly otherEngineer: Actor;
	readonly client: Actor;
	readonly foreignClient: Actor;
	readonly project: Project;
	readonly foreignProject: Project;
};

/**
 * Why the shared world is not available, or `null` when it is.
 *
 * Suites call `assertSuiteIsRunnable` in their first test. Without a reason
 * there, a database that is simply absent produces one honest failure followed
 * by a page of `TypeError: undefined is not an object` from tests that never had
 * a fixture to work with, which buries the only message that matters.
 */
let worldSetupError: string | null = null;

const WORLD_SETUP_HINT =
  "The suites below drive the real application against a live PostgreSQL " +
  "database, so they cannot run without one. Check that DATABASE_URL points at " +
  "a reachable instance, that the migrations have been applied " +
  "(`bun run verify:clean-database` does this from scratch), and that the " +
  "machine running them has network access to it.";

export function assertSuiteIsRunnable(reachable: boolean): void {
	if (reachable && worldSetupError === null) {
		return;
	}

	const reason =
		worldSetupError ??
		`the database did not answer${
			lastConnectionError === null
				? "."
				: ` (${lastConnectionError}).`
		}`;

	throw new Error(
		`This suite cannot run: ${reason}\n\n${WORLD_SETUP_HINT}`,
	);
}

export async function buildWorld(): Promise<World> {
	let lastError: unknown;

	for (let attempt = 0; attempt < WORLD_ATTEMPTS; attempt++) {
		worldAttempt = attempt;
		try {
			const world = await buildWorldOnce();
			worldSetupError = null;
			return world;
		} catch (error) {
			lastError = error;
			worldSetupError =
				`the shared world could not be built after ${WORLD_ATTEMPTS} ` +
				`attempts (last error: ${
					error instanceof Error ? error.message : String(error)
				})`;
			// The world is the longest uninterrupted run of network calls in a
			// suite, so it is where a dropped connection is most likely to land.
			// Clear whatever the attempt managed to commit, then wait for the
			// database to answer again before rebuilding under fresh identities.
			await cleanupFixtures();
			await sleep(WORLD_RETRY_PAUSE_MS);
		}
	}

	throw new Error(`${worldSetupError}. ${WORLD_SETUP_HINT}`, { cause: lastError });
}

async function buildWorldOnce(): Promise<World> {
	const pm = await createPrivilegedActor({
		role: "PM",
		email: itEmail("pm"),
		department: "PRODUCT",
	});
	const engineer = await registerInternal({
		name: "It Engineer",
		email: itEmail("eng"),
		department: "BACKEND",
	});
	const otherEngineer = await registerInternal({
		name: "It Other Engineer",
		email: itEmail("eng2"),
		department: "FRONTEND",
	});
	const client = await createPrivilegedActor({
		role: "CLIENT",
		email: itEmail("client"),
		department: "PRODUCT",
	});
	const foreignClient = await createPrivilegedActor({
		role: "CLIENT",
		email: itEmail("foreign"),
		department: "PRODUCT",
	});

	const project = await createProject(pm, { name: "It Primary Project" });
	const foreignProject = await createProject(pm, {
		name: "It Foreign Project",
		clientName: "It Other Client Co",
	});

	// Creating a project does not enrol its creator as a member, but assigning a
	// task requires membership, so the PM is added explicitly. That is also the
	// shape a real reviewer sets up.
	await addMember(pm, project.id, pm.userId);
	await addMember(pm, project.id, engineer.userId);
	await addMember(pm, project.id, otherEngineer.userId);
	await addMember(pm, project.id, client.userId);
	await addMember(pm, foreignProject.id, pm.userId);
	await addMember(pm, foreignProject.id, foreignClient.userId);

	return { pm, engineer, otherEngineer, client, foreignClient, project, foreignProject };
}

/** A 1x1 PNG, the smallest payload the attachment validator will accept. */
export const PNG_BYTES = Buffer.from(
	"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
	"base64",
);

export function pngForm(
	fileName: string,
	type = "image/png",
	bytes: Buffer = PNG_BYTES,
): FormData {
	const form = new FormData();
	form.append("file", new Blob([new Uint8Array(bytes)], { type }), fileName);
	return form;
}
