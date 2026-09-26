import { app } from "../app";
import { localStorageProvider } from "../modules/attachments/storage/local.storage";
import { hashPassword } from "../modules/auth/password";
import { db } from "../prisma/db";
import { toVarchar } from "../prisma/scalars";

// ---------------------------------------------------------------------------
// DB-integration assessment harness.
//
// Exercises the running app end-to-end through `app.request()` against a live
// PostgreSQL database. It creates its own isolated records (unique `it-*`
// emails) and removes everything it created, child-first, when it finishes.
//
// Run with:  bun run test:integration
// ---------------------------------------------------------------------------

const PNG_BYTES = Buffer.from(
	"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
	"base64",
);

type ApiResult = {
	readonly status: number;
	readonly json: unknown;
	readonly text: string;
	readonly bytes: Buffer;
};

async function api(
	path: string,
	options: {
		readonly method?: string;
		readonly token?: string;
		readonly body?: unknown;
		readonly form?: FormData;
	} = {},
): Promise<ApiResult> {
	const headers: Record<string, string> = {};
	if (options.token) {
		headers.Authorization = `Bearer ${options.token}`;
	}
	let body: string | FormData | undefined;
	if (options.body !== undefined) {
		headers["content-type"] = "application/json";
		body = JSON.stringify(options.body);
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
		// Non-JSON response (binary or HTML); leave json as null.
	}
	return { status: response.status, json, text, bytes };
}

function jsonPath<T>(
	result: ApiResult,
	path: readonly string[],
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

type CheckResult = {
	readonly label: string;
	readonly ok: boolean;
	readonly detail: string;
};

const results: CheckResult[] = [];

function record(label: string, condition: boolean, detail = ""): void {
	results.push({ label, ok: condition, detail });
}

function fail(label: string, detail = ""): void {
	results.push({ label, ok: false, detail });
}

async function login(
	label: string,
	email: string,
	password: string,
): Promise<string> {
	const res = await api("/auth/login", {
		method: "POST",
		body: { email, password },
	});
	const token = jsonPath<string>(res, ["data", "accessToken"]);
	record(
		label,
		res.status === 200 && typeof token === "string",
		`status=${res.status}`,
	);
	return token ?? "";
}

const RUN_ID = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
const itEmail = (label: string): string =>
	`it-${label}-${RUN_ID}@example.local`;

const ownedUserIds: string[] = [];
const ownedProjectIds: string[] = [];
const ownedTaskIds: string[] = [];

async function cleanup(): Promise<void> {
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
					// best-effort: storage file may already be gone
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

	for (const _projectId of ownedProjectIds) {
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
}

async function verifyHealthAndDocs(): Promise<void> {
	const health = await api("/health");
	record(
		"health: GET /health reports ok",
		health.status === 200 &&
			jsonPath(health, ["status"]) === "ok" &&
			typeof jsonPath(health, ["service"]) === "string",
		`status=${health.status}`,
	);

	const live = await api("/health/live");
	record(
		"health: GET /health/live reports ok",
		live.status === 200 && jsonPath(live, ["status"]) === "ok",
		`status=${live.status}`,
	);

	const ready = await api("/health/ready");
	record(
		"health: GET /health/ready reports database connected",
		ready.status === 200 &&
			jsonPath(ready, ["status"]) === "ready" &&
			jsonPath(ready, ["database"]) === "connected",
		`status=${ready.status}`,
	);

	const spec = await api("/openapi.json");
	const specIsObject =
		spec.status === 200 && typeof spec.json === "object" && spec.json !== null;
	record(
		"docs: OPENAPI.JSON serves the document",
		specIsObject && jsonPath(spec, ["openapi"]) === "3.1.0",
		`status=${spec.status}`,
	);
	if (specIsObject) {
		const paths =
			(spec.json as { paths?: Record<string, unknown> }).paths ?? {};
		record(
			"docs: document covers health, auth, client, and docs routes",
			[
				"/health",
				"/health/live",
				"/health/ready",
				"/auth/login",
				"/client/dashboard",
				"/docs",
				"/openapi.json",
			].every((p) => p in paths),
			`documented paths=${Object.keys(paths).length}`,
		);
	}

	const docs = await api("/docs");
	record(
		"docs: GET /docs serves the Scalar UI",
		docs.status === 200 && docs.text.includes("<!doctype html>"),
		`status=${docs.status}`,
	);
}

type RegisteredUser = {
	readonly token: string;
	readonly userId: string;
};

async function registerInternal(input: {
	name: string;
	email: string;
	department: string;
}): Promise<RegisteredUser> {
	const res = await api("/auth/register", {
		method: "POST",
		body: {
			name: input.name,
			email: input.email,
			password: "ItPass#2026",
			department: input.department,
		},
	});
	const token = jsonPath<string>(res, ["data", "accessToken"]) ?? "";
	const userId = jsonPath<string>(res, ["data", "user", "id"]) ?? "";
	if (userId.length > 0) {
		ownedUserIds.push(userId);
	}
	return { token, userId };
}

async function verifyAuth(): Promise<RegisteredUser> {
	const backendEmail = itEmail("be");
	const backend = await registerInternal({
		name: "It Backend",
		email: backendEmail,
		department: "BACKEND",
	});
	record(
		"auth: register creates an INTERNAL account",
		backend.token.length > 0 && backend.userId.length > 0,
		"",
	);

	const dup = await api("/auth/register", {
		method: "POST",
		body: {
			name: "It Backend Dup",
			email: backendEmail,
			password: "ItPass#2026",
			department: "BACKEND",
		},
	});
	record(
		"auth: duplicate email is rejected with 409",
		dup.status === 409 &&
			jsonPath(dup, ["error", "code"]) === "EMAIL_ALREADY_REGISTERED",
		`status=${dup.status}`,
	);

	const me = await api("/auth/me", { token: backend.token });
	record(
		"auth: /auth/me returns the current user",
		me.status === 200 &&
			jsonPath(me, ["data", "user", "email"]) === backendEmail,
		`status=${me.status}`,
	);

	const badToken = await api("/auth/me", { token: "not-a-jwt" });
	record(
		"auth: /auth/me rejects an invalid token with 401",
		badToken.status === 401,
		`status=${badToken.status}`,
	);

	const wrongPassword = await api("/auth/login", {
		method: "POST",
		body: { email: backendEmail, password: "wrong-password" },
	});
	record(
		"auth: wrong password is rejected with 401",
		wrongPassword.status === 401 &&
			jsonPath(wrongPassword, ["error", "code"]) === "INVALID_CREDENTIALS",
		`status=${wrongPassword.status}`,
	);

	return backend;
}

type Fixture = {
	readonly tokenPm: string;
	readonly tokenClient: string;
	readonly projectId: string;
	readonly taskAId: string;
	readonly taskBId: string;
	readonly taskCId: string;
};

async function verifyProjectAndRoles(
	backend: RegisteredUser,
	frontendUserId: string,
): Promise<Fixture> {
	const empty: Fixture = {
		tokenPm: "",
		tokenClient: "",
		projectId: "",
		taskAId: "",
		taskBId: "",
		taskCId: "",
	};

	const pmEmail = itEmail("pm");
	const clientEmail = itEmail("client");
	const pmRow = await db.orm.public.Users.create({
		name: toVarchar<100>("It Project Manager"),
		email: toVarchar<255>(pmEmail),
		passwordHash: await hashPassword("ItPass#2026"),
		role: "PM",
		department: "PRODUCT",
	});
	ownedUserIds.push(pmRow.id);
	const clientRow = await db.orm.public.Users.create({
		name: toVarchar<100>("It Client Guest"),
		email: toVarchar<255>(clientEmail),
		passwordHash: await hashPassword("ItPass#2026"),
		role: "CLIENT",
		department: "CLIENT",
	});
	ownedUserIds.push(clientRow.id);

	const tokenPm = await login("roles: PM can log in", pmEmail, "ItPass#2026");
	const tokenClient = await login(
		"roles: CLIENT can log in",
		clientEmail,
		"ItPass#2026",
	);

	const createdProject = await api("/projects", {
		method: "POST",
		token: tokenPm,
		body: {
			name: `Integration Project ${RUN_ID}`,
			description: "Created by the integration harness.",
		},
	});
	const projectId = jsonPath<string>(createdProject, ["data", "project", "id"]);
	record(
		"roles: PM can create a project",
		createdProject.status === 201 && typeof projectId === "string",
		`status=${createdProject.status}`,
	);
	if (typeof projectId !== "string") {
		return empty;
	}
	ownedProjectIds.push(projectId);

	for (const member of [
		{ label: "backend", id: backend.userId },
		{ label: "frontend", id: frontendUserId },
		{ label: "client", id: clientRow.id },
	]) {
		const added = await api(`/projects/${projectId}/members`, {
			method: "POST",
			token: tokenPm,
			body: { userId: member.id },
		});
		record(
			`roles: PM adds ${member.label} to the project`,
			added.status === 201,
			`status=${added.status}`,
		);
	}

	// The task form needs each member's department to reject an assignee that
	// cannot own the task before the request is sent.
	const memberList = await api(`/projects/${projectId}/members`, {
		token: tokenPm,
	});
	const memberRows = jsonPath<
		Array<{ userId: string; user: { department: string } }>
	>(memberList, ["data", "members"]);
	record(
		"members: the summary includes the user department",
		memberList.status === 200 &&
			(memberRows ?? []).length === 3 &&
			(memberRows ?? []).every(
				(row) => typeof row.user?.department === "string",
			),
		`status=${memberList.status} departments=${(memberRows ?? [])
			.map((row) => `${row.userId.slice(0, 8)}=${row.user?.department ?? "?"}`)
			.join(",")}`,
	);
	record(
		"members: a client member is distinguishable from internal members",
		(memberRows ?? []).some((row) => row.user?.department === "CLIENT") &&
			(memberRows ?? []).some((row) => row.user?.department !== "CLIENT"),
		`departments=${(memberRows ?? [])
			.map((row) => row.user?.department ?? "?")
			.join(",")}`,
	);

	const createdTasks = await Promise.all([
		api(`/projects/${projectId}/tasks`, {
			method: "POST",
			token: tokenPm,
			body: {
				title: "API Integration Spec",
				assignedToId: backend.userId,
				status: "TODO",
				clientVisible: true,
			},
		}),
		api(`/projects/${projectId}/tasks`, {
			method: "POST",
			token: tokenPm,
			body: {
				title: "Frontend Layout",
				assignedToId: frontendUserId,
				status: "TODO",
				clientVisible: true,
			},
		}),
		api(`/projects/${projectId}/tasks`, {
			method: "POST",
			token: tokenPm,
			body: {
				title: "Deployment Runbook",
				assignedToId: backend.userId,
				status: "TODO",
				clientVisible: false,
			},
		}),
	]);
	const taskIds = createdTasks.map(
		(t) => jsonPath<string>(t, ["data", "task", "id"]) ?? "",
	);
	record(
		"roles: PM creates three tasks",
		createdTasks.every((t) => t.status === 201) &&
			taskIds.every((id) => id.length > 0),
		`statuses=${createdTasks.map((t) => t.status).join(",")}`,
	);
	const taskAId = taskIds[0] ?? "";
	const taskBId = taskIds[1] ?? "";
	const taskCId = taskIds[2] ?? "";
	for (const id of taskIds) {
		if (id.length > 0) {
			ownedTaskIds.push(id);
		}
	}

	const depResults = await Promise.all([
		api(`/projects/${projectId}/tasks/${taskCId}/dependencies`, {
			method: "POST",
			token: tokenPm,
			body: { dependencyTaskId: taskAId },
		}),
		api(`/projects/${projectId}/tasks/${taskCId}/dependencies`, {
			method: "POST",
			token: tokenPm,
			body: { dependencyTaskId: taskBId },
		}),
	]);
	record(
		"dependencies: PM wires taskC -> taskA and taskC -> taskB",
		depResults.every((r) => r.status === 201),
		`statuses=${depResults.map((r) => r.status).join(",")}`,
	);

	return { tokenPm, tokenClient, projectId, taskAId, taskBId, taskCId };
}

async function verifyProjectListContract(
	tokenPm: string,
	tokenInternal: string,
	tokenClient: string,
	memberProjectId: string,
): Promise<void> {
	const listQuery = async (
		query: string,
		token = tokenPm,
	): Promise<ApiResult> => api(`/projects${query}`, { token });

	const created = await api("/projects", {
		method: "POST",
		token: tokenPm,
		body: {
			name: `List Contract Project ${RUN_ID}`,
			description: "Filtering, searching, ordering and pagination probe.",
			clientName: "It Client",
			status: "PLANNING",
		},
	});
	const listProjectId =
		jsonPath<string>(created, ["data", "project", "id"]) ?? "";
	record(
		"list: PM creates a PLANNING project",
		created.status === 201 && listProjectId.length > 0,
		`status=${created.status}`,
	);
	if (listProjectId.length === 0) {
		return;
	}
	ownedProjectIds.push(listProjectId);

	const second = await api("/projects", {
		method: "POST",
		token: tokenPm,
		body: {
			name: `List Contract Secondary ${RUN_ID}`,
			status: "ARCHIVED",
		},
	});
	const secondId = jsonPath<string>(second, ["data", "project", "id"]) ?? "";
	if (secondId.length > 0) {
		ownedProjectIds.push(secondId);
	}

	const defaultList = await listQuery("");
	const projects = jsonPath<
		Array<{ id: string; name: string; status: string }>
	>(defaultList, ["data", "projects"]);
	const pagination = jsonPath<{
		page: number;
		limit: number;
		total: number;
		totalPages: number;
	}>(defaultList, ["data", "pagination"]);
	record(
		"list: response carries the existing pagination envelope",
		defaultList.status === 200 &&
			Array.isArray(projects) &&
			pagination !== undefined &&
			pagination.page === 1 &&
			pagination.limit === 20 &&
			pagination.total === (projects?.length ?? -1),
		`status=${defaultList.status} total=${pagination?.total ?? "n/a"}`,
	);

	const projectFields = Object.keys(
		(projects ?? [])[0] ?? ({} as Record<string, unknown>),
	).sort();
	record(
		"list: DTO never exposes deletedAt or relations",
		!projectFields.includes("deletedAt") &&
			!projectFields.includes("members") &&
			!projectFields.includes("tasks"),
		`fields=${projectFields.join(",")}`,
	);

	const filtered = await listQuery(
		`?filters=${encodeURIComponent(JSON.stringify({ status: "PLANNING" }))}`,
	);
	const filteredProjects = jsonPath<Array<{ id: string; status: string }>>(
		filtered,
		["data", "projects"],
	);
	record(
		"list: filters narrows by status",
		filtered.status === 200 &&
			(filteredProjects ?? []).length > 0 &&
			(filteredProjects ?? []).every((p) => p.status === "PLANNING"),
		`status=${filtered.status} count=${filteredProjects?.length ?? -1}`,
	);

	const searched = await listQuery(
		`?searchFilters=${encodeURIComponent(JSON.stringify({ name: RUN_ID }))}`,
	);
	const searchedProjects = jsonPath<Array<{ name: string }>>(searched, [
		"data",
		"projects",
	]);
	record(
		"list: searchFilters matches project names",
		searched.status === 200 &&
			(searchedProjects ?? []).length >= 2 &&
			(searchedProjects ?? []).every((p) => p.name.includes(RUN_ID)),
		`status=${searched.status} count=${searchedProjects?.length ?? -1}`,
	);

	const ranged = await listQuery(
		`?rangedFilters=${encodeURIComponent(
			JSON.stringify([{ key: "createdAt", start: "2000-01-01" }]),
		)}`,
	);
	const rangedProjects = jsonPath<Array<{ id: string }>>(ranged, [
		"data",
		"projects",
	]);
	record(
		"list: rangedFilters applies a lower bound",
		ranged.status === 200 && (rangedProjects ?? []).length > 0,
		`status=${ranged.status} count=${rangedProjects?.length ?? -1}`,
	);

	const noMatches = await listQuery(
		`?rangedFilters=${encodeURIComponent(
			JSON.stringify([{ key: "createdAt", end: "2000-01-01" }]),
		)}`,
	);
	const noMatchProjects = jsonPath<Array<{ id: string }>>(noMatches, [
		"data",
		"projects",
	]);
	record(
		"list: rangedFilters can exclude every project",
		noMatches.status === 200 && (noMatchProjects ?? []).length === 0,
		`status=${noMatches.status} count=${noMatchProjects?.length ?? -1}`,
	);

	const firstPage = await listQuery(
		"?rows=1&page=1&orderKey=createdAt&orderRule=desc",
	);
	const secondPage = await listQuery(
		"?rows=1&page=2&orderKey=createdAt&orderRule=desc",
	);
	const firstPageProjects = jsonPath<Array<{ id: string }>>(firstPage, [
		"data",
		"projects",
	]);
	const secondPageProjects = jsonPath<Array<{ id: string }>>(secondPage, [
		"data",
		"projects",
	]);
	const firstPagePagination = jsonPath<{ page: number; totalPages: number }>(
		firstPage,
		["data", "pagination"],
	);
	record(
		"list: rows and page paginate without overlap",
		firstPage.status === 200 &&
			secondPage.status === 200 &&
			(firstPageProjects ?? []).length === 1 &&
			(secondPageProjects ?? []).length === 1 &&
			firstPageProjects?.[0]?.id !== secondPageProjects?.[0]?.id,
		`first=${firstPageProjects?.[0]?.id ?? "n/a"} second=${secondPageProjects?.[0]?.id ?? "n/a"}`,
	);
	record(
		"list: pagination reports total pages",
		(firstPagePagination?.totalPages ?? 0) >= 2,
		`totalPages=${firstPagePagination?.totalPages ?? "n/a"}`,
	);

	const asc = await listQuery("?rows=100&orderKey=name&orderRule=asc");
	const desc = await listQuery("?rows=100&orderKey=name&orderRule=desc");
	const ascNames = (
		jsonPath<Array<{ name: string }>>(asc, ["data", "projects"]) ?? []
	).map((p) => p.name);
	const descNames = (
		jsonPath<Array<{ name: string }>>(desc, ["data", "projects"]) ?? []
	).map((p) => p.name);
	record(
		"list: orderKey and orderRule drive ordering",
		asc.status === 200 &&
			desc.status === 200 &&
			ascNames.length > 1 &&
			JSON.stringify(ascNames) === JSON.stringify([...ascNames].sort()) &&
			JSON.stringify(descNames) ===
				JSON.stringify([...descNames].sort().reverse()),
		`asc=${ascNames.slice(0, 2).join(" | ")}`,
	);

	const internalList = await listQuery("", tokenInternal);
	const internalProjects = jsonPath<Array<{ id: string }>>(internalList, [
		"data",
		"projects",
	]);
	record(
		"list: internal users only receive assigned projects",
		internalList.status === 200 &&
			(internalProjects ?? []).length > 0 &&
			(internalProjects ?? []).every((p) => p.id === memberProjectId),
		`status=${internalList.status} count=${internalProjects?.length ?? -1}`,
	);

	const escalation = await listQuery(
		`?filters=${encodeURIComponent(JSON.stringify({ id: listProjectId }))}`,
		tokenInternal,
	);
	const escalationProjects = jsonPath<Array<{ id: string }>>(escalation, [
		"data",
		"projects",
	]);
	record(
		"list: filters cannot widen the caller's access scope",
		escalation.status === 200 &&
			!(escalationProjects ?? []).some((p) => p.id === listProjectId),
		`status=${escalation.status} count=${escalationProjects?.length ?? -1}`,
	);

	const clientList = await listQuery("", tokenClient);
	record(
		"list: client guests cannot read the internal project api",
		clientList.status === 403,
		`status=${clientList.status}`,
	);

	const unauthenticated = await api("/projects?rows=1");
	record(
		"list: unauthenticated list request is rejected",
		unauthenticated.status === 401,
		`status=${unauthenticated.status}`,
	);

	const invalidParams = await Promise.all([
		listQuery("?search=anything"),
		listQuery(`?filters=${encodeURIComponent("{not json")}`),
		listQuery(
			`?filters=${encodeURIComponent(JSON.stringify({ deletedAt: null }))}`,
		),
		listQuery("?rows=0"),
		listQuery("?orderKey=passwordHash"),
	]);
	record(
		"list: invalid query parameters are rejected",
		invalidParams.every((result) => result.status === 400),
		`statuses=${invalidParams.map((r) => r.status).join(",")}`,
	);

	const archived = await api(`/projects/${listProjectId}`, {
		method: "PATCH",
		token: tokenPm,
		body: { status: "ARCHIVED" },
	});
	record(
		"list: PM can update a project",
		archived.status === 200,
		`status=${archived.status}`,
	);

	const deleteForbidden = await api(`/projects/${listProjectId}`, {
		method: "DELETE",
		token: tokenInternal,
	});
	record(
		"list: internal users cannot delete a project",
		deleteForbidden.status === 403,
		`status=${deleteForbidden.status}`,
	);

	const softDeleted = await api(`/projects/${listProjectId}`, {
		method: "DELETE",
		token: tokenPm,
	});
	record(
		"list: PM soft deletes a project",
		softDeleted.status === 204,
		`status=${softDeleted.status}`,
	);

	const afterDelete = await listQuery("?rows=100");
	const afterDeleteProjects = jsonPath<Array<{ id: string }>>(afterDelete, [
		"data",
		"projects",
	]);
	record(
		"list: soft deleted projects disappear from the list",
		afterDelete.status === 200 &&
			!(afterDeleteProjects ?? []).some((p) => p.id === listProjectId),
		`status=${afterDelete.status}`,
	);

	const detailAfterDelete = await api(`/projects/${listProjectId}`, {
		token: tokenPm,
	});
	record(
		"list: soft deleted projects are not retrievable by id",
		detailAfterDelete.status === 404,
		`status=${detailAfterDelete.status}`,
	);

	const row = await db.orm.public.Projects.first({ id: listProjectId });
	record(
		"list: soft delete keeps the row and sets deletedAt",
		row !== null && row !== undefined && row.deletedAt !== null,
		`deletedAt=${row === null || row === undefined ? "row missing" : String(row.deletedAt)}`,
	);
}

async function verifyAuthzBlocking(
	tokenBackend: string,
	tokenFrontend: string,
	tokenClient: string,
	projectId: string,
	taskAId: string,
	taskBId: string,
	taskCId: string,
): Promise<void> {
	const clientWrite = await api(`/projects/${projectId}/tasks/${taskAId}`, {
		method: "PATCH",
		token: tokenClient,
		body: { title: "client edit", version: 1 },
	});
	record(
		"authz: CLIENT cannot update a task",
		clientWrite.status === 403,
		`status=${clientWrite.status}`,
	);

	const yankTitle = await api(`/projects/${projectId}/tasks/${taskBId}`, {
		method: "PATCH",
		token: tokenBackend,
		body: { title: "not yours", version: 1 },
	});
	record(
		"authz: INTERNAL cannot edit a task assigned to another user",
		yankTitle.status === 403,
		`status=${yankTitle.status}`,
	);

	const startA = await api(`/projects/${projectId}/tasks/${taskAId}`, {
		method: "PATCH",
		token: tokenBackend,
		body: { status: "IN_PROGRESS", version: 1 },
	});
	record(
		"authz: assignee can start their own task",
		startA.status === 200,
		`status=${startA.status}`,
	);

	// taskC requires A and B; A is not DONE yet, so starting taskC is blocked.
	const blockedStart = await api(`/projects/${projectId}/tasks/${taskCId}`, {
		method: "PATCH",
		token: tokenBackend,
		body: { status: "IN_PROGRESS", version: 1 },
	});
	record(
		"dependencies: starting taskC while a dependency is incomplete returns TASK_BLOCKED",
		blockedStart.status === 409 &&
			jsonPath(blockedStart, ["error", "code"]) === "TASK_BLOCKED",
		`status=${blockedStart.status}`,
	);

	// Backend (assignee) completes taskA.
	const doneA = await api(`/projects/${projectId}/tasks/${taskAId}`, {
		method: "PATCH",
		token: tokenBackend,
		body: { status: "DONE", version: 2 },
	});
	record(
		"dependencies: assignee can complete their own task",
		doneA.status === 200,
		`status=${doneA.status}`,
	);

	// Backend cannot touch taskB (frontend's).
	const startB = await api(`/projects/${projectId}/tasks/${taskBId}`, {
		method: "PATCH",
		token: tokenBackend,
		body: { status: "IN_PROGRESS", version: 1 },
	});
	record(
		"authz: INTERNAL cannot start a task assigned to another user",
		startB.status === 403,
		`status=${startB.status}`,
	);

	// Frontend (own assignee) completes taskB.
	const startB2 = await api(`/projects/${projectId}/tasks/${taskBId}`, {
		method: "PATCH",
		token: tokenFrontend,
		body: { status: "IN_PROGRESS", version: 1 },
	});
	const doneB2 = await api(`/projects/${projectId}/tasks/${taskBId}`, {
		method: "PATCH",
		token: tokenFrontend,
		body: { status: "DONE", version: 2 },
	});
	record(
		"dependencies: second assignee completes their task",
		startB2.status === 200 && doneB2.status === 200,
		`startB2=${startB2.status}, doneB2=${doneB2.status}`,
	);

	// Both dependencies are DONE now: taskC can start.
	const startC = await api(`/projects/${projectId}/tasks/${taskCId}`, {
		method: "PATCH",
		token: tokenBackend,
		body: { status: "IN_PROGRESS", version: 1 },
	});
	record(
		"dependencies: taskC starts once its dependencies are complete",
		startC.status === 200,
		`status=${startC.status}`,
	);

	// Stale optimistic-lock version after taskC reached version 2.
	const staleEdit = await api(`/projects/${projectId}/tasks/${taskCId}`, {
		method: "PATCH",
		token: tokenBackend,
		body: { title: "Runbook v2", version: 1 },
	});
	record(
		"optimistic: stale version returns TASK_VERSION_CONFLICT",
		staleEdit.status === 409 &&
			jsonPath(staleEdit, ["error", "code"]) === "TASK_VERSION_CONFLICT",
		`status=${staleEdit.status}`,
	);
	const freshEdit = await api(`/projects/${projectId}/tasks/${taskCId}`, {
		method: "PATCH",
		token: tokenBackend,
		body: { title: "Runbook v2", version: 2 },
	});
	record(
		"optimistic: current version succeeds",
		freshEdit.status === 200 &&
			jsonPath(freshEdit, ["data", "task", "title"]) === "Runbook v2",
		`status=${freshEdit.status}`,
	);
}

async function verifyClientPortal(
	tokenClient: string,
	projectId: string,
	taskAId: string,
	taskCId: string,
): Promise<void> {
	const dashboard = await api("/client/dashboard", { token: tokenClient });
	const projects = jsonPath<Array<{ id: string }>>(dashboard, [
		"data",
		"projects",
	]);
	record(
		"client: dashboard lists the tenant project",
		dashboard.status === 200 &&
			Array.isArray(projects) &&
			projects.some((p) => p.id === projectId),
		`status=${dashboard.status}`,
	);

	const tasks = await api(`/client/projects/${projectId}/tasks?limit=100`, {
		token: tokenClient,
	});
	const clientTasks = jsonPath<Array<{ clientVisible: boolean }>>(tasks, [
		"data",
		"tasks",
	]);
	const taskCLeaked =
		Array.isArray(clientTasks) &&
		clientTasks.some(
			(t) => (t as { title?: string }).title === "Deployment Runbook",
		);
	record(
		"client: task list only exposes client-visible tasks",
		tasks.status === 200 &&
			Array.isArray(clientTasks) &&
			clientTasks.every((t) => t.clientVisible === true) &&
			!taskCLeaked,
		`status=${tasks.status}, count=${Array.isArray(clientTasks) ? clientTasks.length : "n/a"}`,
	);

	const hidden = await api(`/client/projects/${projectId}/tasks/${taskCId}`, {
		token: tokenClient,
	});
	record(
		"client: internal-only task is unreachable by CLIENT",
		hidden.status === 403 || hidden.status === 404,
		`status=${hidden.status}`,
	);

	const visible = await api(`/client/projects/${projectId}/tasks/${taskAId}`, {
		token: tokenClient,
	});
	record(
		"client: client-visible task is readable",
		visible.status === 200,
		`status=${visible.status}`,
	);
}

async function verifyAudit(
	tokenPm: string,
	tokenClient: string,
	projectId: string,
	taskCId: string,
): Promise<void> {
	const audit = await api(
		`/projects/${projectId}/tasks/${taskCId}/audit-logs`,
		{
			token: tokenPm,
		},
	);
	const total = jsonPath<number>(audit, ["data", "pagination", "total"]);
	record(
		"audit: task changes are written to the immutable log",
		audit.status === 200 && typeof total === "number" && total >= 1,
		`status=${audit.status}, total=${String(total)}`,
	);

	const clientAudit = await api(
		`/projects/${projectId}/tasks/${taskCId}/audit-logs`,
		{ token: tokenClient },
	);
	record(
		"audit: CLIENT cannot read the audit log",
		clientAudit.status === 403,
		`status=${clientAudit.status}`,
	);
}

async function verifyAttachments(
	tokenBackend: string,
	tokenClient: string,
	projectId: string,
	taskAId: string,
): Promise<void> {
	const form = new FormData();
	form.append(
		"file",
		new File([new Uint8Array(PNG_BYTES)], "screenshot.png", {
			type: "image/png",
		}),
	);
	const upload = await api(
		`/projects/${projectId}/tasks/${taskAId}/attachments`,
		{
			method: "POST",
			token: tokenBackend,
			form,
		},
	);
	const attachmentId = jsonPath<string>(upload, ["data", "attachment", "id"]);
	record(
		"attachments: valid PNG upload succeeds",
		upload.status === 201 &&
			typeof attachmentId === "string" &&
			jsonPath(upload, ["data", "attachment", "mimeType"]) === "image/png",
		`status=${upload.status}`,
	);

	if (typeof attachmentId === "string" && attachmentId.length > 0) {
		const list = await api(
			`/projects/${projectId}/tasks/${taskAId}/attachments`,
			{ token: tokenBackend },
		);
		const rows = jsonPath<Array<{ id: string }>>(list, ["data", "attachments"]);
		record(
			"attachments: upload is listed",
			list.status === 200 &&
				Array.isArray(rows) &&
				rows.some((r) => r.id === attachmentId),
			`status=${list.status}`,
		);

		const download = await api(
			`/projects/${projectId}/tasks/${taskAId}/attachments/${attachmentId}`,
			{ token: tokenBackend },
		);
		record(
			"attachments: download returns the original bytes",
			download.status === 200 && download.bytes.equals(PNG_BYTES),
			`status=${download.status}, bytes=${download.bytes.byteLength}`,
		);

		const removed = await api(
			`/projects/${projectId}/tasks/${taskAId}/attachments/${attachmentId}`,
			{ method: "DELETE", token: tokenBackend },
		);
		record(
			"attachments: soft delete succeeds",
			removed.status === 204,
			`status=${removed.status}`,
		);
	}

	const clientList = await api(
		`/projects/${projectId}/tasks/${taskAId}/attachments`,
		{ token: tokenClient },
	);
	record(
		"attachments: CLIENT cannot access attachments",
		clientList.status === 403,
		`status=${clientList.status}`,
	);

	const fakeForm = new FormData();
	fakeForm.append(
		"file",
		new File([new TextEncoder().encode("not an image")], "notes.txt", {
			type: "text/plain",
		}),
	);
	const rejected = await api(
		`/projects/${projectId}/tasks/${taskAId}/attachments`,
		{
			method: "POST",
			token: tokenBackend,
			form: fakeForm,
		},
	);
	record(
		"attachments: disallowed content is rejected",
		rejected.status === 415 &&
			jsonPath(rejected, ["error", "code"]) === "ATTACHMENT_UNSUPPORTED_TYPE",
		`status=${rejected.status}`,
	);
}

async function verifyFlatTaskApi(
	tokenPm: string,
	tokenInternal: string,
	tokenClient: string,
	backendUserId: string,
	frontendUserId: string,
	projectId: string,
): Promise<void> {
	// --- create via the flat endpoint, with explicit priority/department ------
	const created = await api("/tasks", {
		method: "POST",
		token: tokenPm,
		body: {
			projectId,
			title: "Flat contract task",
			description: "Created through POST /tasks.",
			priority: "URGENT",
			department: "BACKEND",
			assignedToId: backendUserId,
		},
	});
	const taskId = jsonPath<string>(created, ["data", "task", "id"]) ?? "";
	record(
		"flat tasks: PM creates a task through POST /tasks",
		created.status === 201 && taskId.length > 0,
		`status=${created.status}`,
	);
	if (taskId.length === 0) {
		return;
	}
	ownedTaskIds.push(taskId);

	record(
		"flat tasks: create persists the requested priority and department",
		jsonPath(created, ["data", "task", "priority"]) === "URGENT" &&
			jsonPath(created, ["data", "task", "department"]) === "BACKEND",
		"",
	);

	const stored = await db.orm.public.Tasks.where((t) =>
		t.id.eq(taskId),
	).first();
	record(
		"flat tasks: priority and department are persisted in the database",
		stored?.priority === "URGENT" && stored?.department === "BACKEND",
		`priority=${stored?.priority} department=${stored?.department}`,
	);

	// --- default inference ---------------------------------------------------
	const inferred = await api("/tasks", {
		method: "POST",
		token: tokenPm,
		body: { projectId, title: "Department inferred from assignee" },
	});
	const inferredId = jsonPath<string>(inferred, ["data", "task", "id"]) ?? "";
	if (inferredId.length > 0) {
		ownedTaskIds.push(inferredId);
	}
	record(
		"flat tasks: an unassigned task defaults to MEDIUM/PRODUCT",
		inferred.status === 201 &&
			jsonPath(inferred, ["data", "task", "priority"]) === "MEDIUM" &&
			jsonPath(inferred, ["data", "task", "department"]) === "PRODUCT",
		`status=${inferred.status}`,
	);

	// --- department consistency ---------------------------------------------
	const mismatch = await api("/tasks", {
		method: "POST",
		token: tokenPm,
		body: {
			projectId,
			title: "Mismatched department",
			department: "FRONTEND",
			assignedToId: backendUserId,
		},
	});
	record(
		"flat tasks: assigning across departments is rejected with 400",
		mismatch.status === 400 &&
			jsonPath(mismatch, ["error", "code"]) === "TASK_DEPARTMENT_MISMATCH",
		`status=${mismatch.status}`,
	);

	const clientDepartment = await api("/tasks", {
		method: "POST",
		token: tokenPm,
		body: { projectId, title: "Client as team", department: "CLIENT" },
	});
	record(
		"flat tasks: CLIENT is rejected as a task department with 400",
		clientDepartment.status === 400,
		`status=${clientDepartment.status}`,
	);

	// --- field-level authorization ------------------------------------------
	const internalEdit = await api(`/tasks/${taskId}`, {
		method: "PATCH",
		token: tokenInternal,
		body: { version: 1, priority: "LOW" },
	});
	record(
		"flat tasks: INTERNAL cannot change task priority",
		internalEdit.status === 403,
		`status=${internalEdit.status}`,
	);

	const internalAssigneeDepartment = await api("/tasks", {
		method: "POST",
		token: tokenPm,
		body: {
			projectId,
			title: "Frontend task",
			department: "FRONTEND",
			assignedToId: frontendUserId,
		},
	});
	const frontendTaskId =
		jsonPath<string>(internalAssigneeDepartment, ["data", "task", "id"]) ?? "";
	if (frontendTaskId.length > 0) {
		ownedTaskIds.push(frontendTaskId);
	}
	record(
		"flat tasks: assignee and department can be created consistently",
		internalAssigneeDepartment.status === 201,
		`status=${internalAssigneeDepartment.status}`,
	);

	// --- detail ---------------------------------------------------------------
	const detail = await api(`/tasks/${taskId}`, { token: tokenPm });
	record(
		"flat tasks: GET /tasks/:id includes the project and assignee summaries",
		detail.status === 200 &&
			jsonPath(detail, ["data", "task", "project", "id"]) === projectId &&
			jsonPath(detail, ["data", "task", "assignedTo", "id"]) ===
				backendUserId &&
			jsonPath(detail, ["data", "task", "assignedTo", "department"]) ===
				"BACKEND",
		`status=${detail.status}`,
	);

	record(
		"flat tasks: detail never leaks the soft-delete column",
		!Object.hasOwn(
			jsonPath<Record<string, unknown>>(detail, ["data", "task"]) ?? {},
			"deletedAt",
		),
		"",
	);

	// --- list contract --------------------------------------------------------
	const listTasksApi = async (
		query: string,
		token = tokenPm,
	): Promise<ApiResult> => api(`/tasks${query}`, { token });

	const all = await listTasksApi("");
	record(
		"flat tasks: GET /tasks returns a paginated envelope",
		all.status === 200 && Array.isArray(jsonPath(all, ["data", "tasks"])),
		`status=${all.status}`,
	);

	const byPriority = await listTasksApi(
		`?filters=${encodeURIComponent(JSON.stringify({ priority: "URGENT" }))}`,
	);
	const priorityRows = jsonPath<unknown[]>(byPriority, ["data", "tasks"]) ?? [];
	record(
		"flat tasks: filtering by priority works",
		byPriority.status === 200 &&
			priorityRows.length > 0 &&
			priorityRows.every(
				(row) => (row as { priority: string }).priority === "URGENT",
			),
		`status=${byPriority.status} rows=${priorityRows.length}`,
	);

	const byDepartment = await listTasksApi(
		`?filters=${encodeURIComponent(JSON.stringify({ department: "BACKEND" }))}`,
	);
	const departmentRows =
		jsonPath<unknown[]>(byDepartment, ["data", "tasks"]) ?? [];
	record(
		"flat tasks: filtering by department works",
		byDepartment.status === 200 &&
			departmentRows.length > 0 &&
			departmentRows.every(
				(row) => (row as { department: string }).department === "BACKEND",
			),
		`status=${byDepartment.status} rows=${departmentRows.length}`,
	);

	const byTitle = await listTasksApi(
		`?searchFilters=${encodeURIComponent(JSON.stringify({ title: "Flat contract" }))}`,
	);
	record(
		"flat tasks: searching by title works",
		byTitle.status === 200 &&
			(jsonPath<unknown[]>(byTitle, ["data", "tasks"]) ?? []).length === 1,
		`status=${byTitle.status}`,
	);

	const sorted = await listTasksApi(
		"?orderKey=priority&orderRule=desc&rows=100",
	);
	record(
		"flat tasks: ordering by priority is accepted",
		sorted.status === 200,
		`status=${sorted.status}`,
	);

	const badFilter = await listTasksApi(
		`?filters=${encodeURIComponent(JSON.stringify({ deletedAt: "x" }))}`,
	);
	record(
		"flat tasks: a filter outside the allow-list is rejected",
		badFilter.status === 400,
		`status=${badFilter.status}`,
	);

	const badOrder = await listTasksApi("?orderKey=deletedAt");
	record(
		"flat tasks: an orderKey outside the allow-list is rejected",
		badOrder.status === 400,
		`status=${badOrder.status}`,
	);

	// --- ABAC scoping ---------------------------------------------------------
	const clientList = await listTasksApi("", tokenClient);
	record(
		"flat tasks: CLIENT is denied the internal task list with 403",
		clientList.status === 403,
		`status=${clientList.status}`,
	);

	const clientDetail = await api(`/tasks/${taskId}`, { token: tokenClient });
	record(
		"flat tasks: CLIENT is denied the internal task detail with 403",
		clientDetail.status === 403,
		`status=${clientDetail.status}`,
	);

	// An internal user with no memberships must not see another team's tasks.
	const outsider = await registerInternal({
		name: "It Outsider",
		email: itEmail("outsider"),
		department: "BACKEND",
	});
	const outsiderList = await listTasksApi("", outsider.token);
	const outsiderRows =
		jsonPath<unknown[]>(outsiderList, ["data", "tasks"]) ?? [];
	record(
		"flat tasks: an internal user with no memberships sees an empty list",
		outsiderList.status === 200 && outsiderRows.length === 0,
		`status=${outsiderList.status} rows=${outsiderRows.length}`,
	);

	const outsiderDetail = await api(`/tasks/${taskId}`, {
		token: outsider.token,
	});
	record(
		"flat tasks: an internal user cannot read a task outside their projects",
		outsiderDetail.status === 403 || outsiderDetail.status === 404,
		`status=${outsiderDetail.status}`,
	);

	// --- soft delete ----------------------------------------------------------
	const detailForVersion = await api(`/tasks/${taskId}`, { token: tokenPm });
	const version =
		jsonPath<number>(detailForVersion, ["data", "task", "version"]) ?? 1;
	const deleted = await api(`/tasks/${taskId}?version=${version}`, {
		method: "DELETE",
		token: tokenPm,
	});
	record(
		"flat tasks: PM soft deletes a task through DELETE /tasks/:id",
		deleted.status === 204,
		`status=${deleted.status}`,
	);

	const gone = await api(`/tasks/${taskId}`, { token: tokenPm });
	record(
		"flat tasks: a soft deleted task is no longer readable",
		gone.status === 404,
		`status=${gone.status}`,
	);
}

async function main(): Promise<void> {
	console.log(`[integration] run id: ${RUN_ID}`);
	console.log("[integration] target: in-process app (hono app.request)");

	try {
		await db.orm.public.Users.aggregate((aggregate) => ({
			total: aggregate.count(),
		}));
	} catch {
		fail("setup: database is unreachable", "");
		return;
	}

	try {
		await verifyHealthAndDocs();

		const backend = await verifyAuth();

		const frontend = await registerInternal({
			name: "It Frontend",
			email: itEmail("fe"),
			department: "FRONTEND",
		});

		const fixture = await verifyProjectAndRoles(backend, frontend.userId);
		if (fixture.projectId.length === 0) {
			fail("fixture: project could not be created", "");
			return;
		}

		await verifyProjectListContract(
			fixture.tokenPm,
			frontend.token,
			fixture.tokenClient,
			fixture.projectId,
		);
		await verifyAuthzBlocking(
			backend.token,
			frontend.token,
			fixture.tokenClient,
			fixture.projectId,
			fixture.taskAId,
			fixture.taskBId,
			fixture.taskCId,
		);
		await verifyClientPortal(
			fixture.tokenClient,
			fixture.projectId,
			fixture.taskAId,
			fixture.taskCId,
		);
		await verifyAudit(
			fixture.tokenPm,
			fixture.tokenClient,
			fixture.projectId,
			fixture.taskCId,
		);
		await verifyAttachments(
			backend.token,
			fixture.tokenClient,
			fixture.projectId,
			fixture.taskAId,
		);
		await verifyFlatTaskApi(
			fixture.tokenPm,
			frontend.token,
			fixture.tokenClient,
			backend.userId,
			frontend.userId,
			fixture.projectId,
		);
	} catch (error) {
		fail(
			"harness: unexpected error",
			error instanceof Error ? (error.stack ?? error.message) : String(error),
		);
	} finally {
		await cleanup().catch(() => {});
	}
}

await main();
const failed = results.filter((r) => !r.ok);
console.log("");
console.log("Integration results");
console.log(`  passed: ${results.length - failed.length}`);
console.log(`  failed: ${failed.length}`);
for (const result of results) {
	console.log(
		`  [${result.ok ? "PASS" : "FAIL"}] ${result.label}${result.detail ? ` -> ${result.detail}` : ""}`,
	);
}
await db.close().catch(() => {});
process.exit(failed.length > 0 ? 1 : 0);
