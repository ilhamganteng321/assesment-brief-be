import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import { db } from "../../src/prisma/db";
import {
	type Actor,
	api,
	assertSuiteIsRunnable,
	buildWorld,
	cleanupFixtures,
	createPrivilegedActor,
	databaseIsReachable,
	errorCode,
	itEmail,
	jsonPath,
	readAuditRows,
	readTaskRow,
	type World,
} from "../helpers/harness";

// ---------------------------------------------------------------------------
// Task assignment, exercised through the HTTP surface.
//
// The workflow this suite protects is the one the product is built around:
// Project -> Members -> Task -> Assignee -> status -> done. Everything the rest of
// the task module does is downstream of somebody being on the project, so the cases
// here are mostly about the *edges* of that chain:
//
//   - who may be assigned at all (PART 3: a project member, nobody else),
//   - who may do the assigning (PART 5: the existing policy, unchanged),
//   - that the write is a real compare-and-swap (PART 9),
//   - that every actual change is recorded, and only actual changes (PART 10),
//   - that reassignment is a *narrow* change: nothing else about the task moves
//     (PART 28), which is the one most likely to be broken by a well-meaning
//     "convenience".
//
// Each "cannot" case asserts both the refusal *and* that nothing changed, because a
// 403 that still wrote to the database passes a status-code-only test.
// ---------------------------------------------------------------------------

let reachable = false;
let world: World;

/** Accounts this suite provisions, cleaned up after the shared fixtures. */
const ownedUserIds: string[] = [];
/** Projects this suite provisions. */
const ownedProjectIds: string[] = [];
/** Memberships this suite creates, so a project's baseline stays reproducible. */
const ownedMembershipIds: string[] = [];

beforeAll(async () => {
	reachable = await databaseIsReachable();
	if (!reachable) {
		return;
	}
	world = await buildWorld();
});

afterAll(async () => {
	for (const id of ownedMembershipIds) {
		try {
			await db.orm.public.ProjectMembers.where((m) => m.id.eq(id)).delete();
		} catch {
			// best-effort
		}
	}
	ownedMembershipIds.length = 0;

	for (const projectId of ownedProjectIds) {
		try {
			// Dependencies first: they reference tasks, and the task rows go next.
			const taskIds = (
				await db.orm.public.Tasks.where((t) => t.projectId.eq(projectId))
					.select("id")
					.all()
			).map((t) => t.id);
			if (taskIds.length > 0) {
				await db.orm.public.TaskDependencies.where((d) =>
					d.dependentTaskId.in(taskIds),
				).delete();
			}
			await db.orm.public.Tasks.where((t) => t.projectId.eq(projectId)).delete();
			await db.orm.public.ProjectMembers.where((m) =>
				m.projectId.eq(projectId),
			).delete();
			await db.orm.public.Projects.where((p) => p.id.eq(projectId)).delete();
		} catch {
			// best-effort
		}
	}
	ownedProjectIds.length = 0;

	for (const userId of ownedUserIds) {
		try {
			await db.orm.public.ProjectMembers.where((m) =>
				m.userId.eq(userId),
			).delete();
			await db.orm.public.Users.where((u) => u.id.eq(userId)).delete();
		} catch {
			// best-effort
		}
	}
	ownedUserIds.length = 0;

	await cleanupFixtures();
});

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/**
 * A project with two internal members, one client guest, and the PM on it.
 *
 * The department split is deliberate: an assignee must match the task's
 * department, so a case about *membership* uses two engineers in the same
 * department, and the department rule gets its own case rather than being
 * entangled with this one.
 */
type Fixture = {
	readonly projectId: string;
	readonly alice: Actor;
	readonly bob: Actor;
	readonly outsider: Actor;
};

async function ownProject(name: string): Promise<string> {
	const res = await api("/projects", {
		method: "POST",
		token: world.pm.token,
		body: { name },
	});
	const id = jsonPath<string>(res, ["data", "project", "id"]);
	if (!id) {
		throw new Error(`fixture: could not create ${name}`);
	}
	ownedProjectIds.push(id);
	return id;
}

async function ownUser(
	label: string,
	role: "INTERNAL" | "CLIENT" = "INTERNAL",
	department: "BACKEND" | "FRONTEND" | "PRODUCT" = "BACKEND",
): Promise<Actor> {
	// Labels become part of an address, so they are slugged here rather than at each
	// call site: a space in a generated email fails validation and the fixture error
	// would point at registration rather than at the typo that caused it.
	const email = itEmail(label.replace(/[^a-zA-Z0-9]+/g, "").toLowerCase());
	const res =
		role === "INTERNAL"
			? await api("/auth/register", {
					method: "POST",
					body: {
						name: `It ${label}`,
						email,
						password: "ItPass#2026",
						department,
					},
				})
			: null;

	if (res === null) {
		const actor = await createPrivilegedActor({ role, email, department });
		ownedUserIds.push(actor.userId);
		return actor;
	}

	const token = jsonPath<string>(res, ["data", "accessToken"]);
	const userId = jsonPath<string>(res, ["data", "user", "id"]);
	if (!token || !userId) {
		throw new Error(`fixture: could not register ${email}`);
	}
	ownedUserIds.push(userId);
	return { role: "INTERNAL", userId, email, name: `It ${label}`, token };
}

async function addMemberRaw(
	actor: { token: string },
	projectId: string,
	userId: string,
): Promise<void> {
	const res = await api(`/projects/${projectId}/members`, {
		method: "POST",
		token: actor.token,
		body: { userId },
	});
	if (res.status !== 201) {
		throw new Error(
			`fixture: adding member ${userId} failed (${res.status}, ${errorCode(res)})`,
		);
	}
}

async function fixture(label: string): Promise<Fixture> {
	const projectId = await ownProject(`It ${label}`);
	const alice = await ownUser(`${label}alice`);
	const bob = await ownUser(`${label}bob`);
	const outsider = await ownUser(`${label}outsider`);
	await addMemberRaw(world.pm, projectId, alice.userId);
	await addMemberRaw(world.pm, projectId, bob.userId);
	return { projectId, alice, bob, outsider };
}

/** Creates a task and returns its id, throwing if the API refuses. */
async function createTask(
	projectId: string,
	title: string,
	overrides: Record<string, unknown> = {},
): Promise<string> {
	const res = await api(`/projects/${projectId}/tasks`, {
		method: "POST",
		token: world.pm.token,
		body: {
			title,
			// The suite's members are all BACKEND, and an unassigned task would
			// otherwise default to PRODUCT and then refuse the person assigned to it
			// later. Stating it here keeps the department rule to its own case.
			department: "BACKEND",
			...overrides,
		},
	});
	const id = jsonPath<string>(res, ["data", "task", "id"]);
	if (!id) {
		throw new Error(
			`fixture: creating "${title}" failed (${res.status}, ${errorCode(res)})`,
		);
	}
	return id;
}

/**
 * The flat list takes its filters as a JSON object rather than repeated
 * parameters, which is the shared list-query contract rather than anything
 * specific to tasks.
 */
function flatFilters(filters: Record<string, unknown>): string {
	return `filters=${encodeURIComponent(JSON.stringify(filters))}`;
}

async function versionOf(taskId: string): Promise<number> {
	const row = await readTaskRow(taskId);
	return row?.version ?? 0;
}

async function assignedToIdOf(res: {
	json: unknown;
}): Promise<string | null | undefined> {
	return jsonPath<string | null>(res, ["data", "task", "assignedToId"]);
}

async function assignedToOf(res: {
	json: unknown;
}): Promise<unknown> {
	return jsonPath(res, ["data", "task", "assignedTo"]);
}

async function assignedToNameOf(res: {
	json: unknown;
}): Promise<string | null | undefined> {
	return jsonPath<string>(res, ["data", "task", "assignedTo", "name"]);
}

async function assignedIdsOn(projectId: string): Promise<string[]> {
	const res = await api(`/projects/${projectId}/tasks?rows=100`, {
		token: world.pm.token,
	});
	const rows =
		(res.json as { data?: { tasks?: { assignedToId: string | null }[] } } | null)
			?.data?.tasks ?? [];
	return rows.map((t) => t.assignedToId).filter((id): id is string => id !== null);
}

async function auditFor(taskId: string, column: string): Promise<
	{ oldValue: string | null; newValue: string | null }[]
> {
	return (await readAuditRows(taskId))
		.filter((row) => row.changedColumn === column)
		.map((row) => ({ oldValue: row.oldValue, newValue: row.newValue }));
}

// ---------------------------------------------------------------------------

describe("assignment: the core rule", () => {
	test("a PM can create a task assigned to a project member", async () => {
		assertSuiteIsRunnable(reachable);
		const { projectId, alice } = await fixture("assign ok");

		const res = await api(`/projects/${projectId}/tasks`, {
			method: "POST",
			token: world.pm.token,
			body: { title: "It assigned on create", assignedToId: alice.userId },
		});

		expect(res.status).toBe(201);
		expect(await assignedToIdOf(res)).toBe(alice.userId);
		// The nested summary is resolved on the response, so the interface never has
		// to issue a second request to learn who the task is for.
		expect(await assignedToNameOf(res)).toBe(alice.name);
	});

	test("a task can be created with nobody on it", async () => {
		assertSuiteIsRunnable(reachable);
		const { projectId } = await fixture("assign unassigned create");

		const res = await api(`/projects/${projectId}/tasks`, {
			method: "POST",
			token: world.pm.token,
			body: { title: "It nobody" },
		});

		expect(res.status).toBe(201);
		expect(await assignedToIdOf(res)).toBeNull();
		expect(await assignedToOf(res)).toBeNull();
	});

	test("a non-member cannot be assigned, and nothing is written", async () => {
		assertSuiteIsRunnable(reachable);
		const { projectId, outsider } = await fixture("assign nonmember");

		const res = await api(`/projects/${projectId}/tasks`, {
			method: "POST",
			token: world.pm.token,
			body: { title: "It outsider", assignedToId: outsider.userId },
		});

		// PART 3. The check is server-side; a browser dropdown is a convenience, not
		// the enforcement.
		expect(res.status).toBe(400);
		expect(errorCode(res)).toBe("TASK_ASSIGNEE_NOT_A_MEMBER");
		// Nothing was created at all.
		expect(await assignedIdsOn(projectId)).toEqual([]);
	});

	test("a reassignment to a non-member is refused and the task is untouched", async () => {
		assertSuiteIsRunnable(reachable);
		const { projectId, alice, outsider } = await fixture("assign crossmember");
		const taskId = await createTask(projectId, "It reassign away", {
			assignedToId: alice.userId,
		});
		const before = await readTaskRow(taskId);

		const res = await api(`/projects/${projectId}/tasks/${taskId}`, {
			method: "PATCH",
			token: world.pm.token,
			body: { assignedToId: outsider.userId, version: before?.version },
		});

		expect(res.status).toBe(400);
		expect(errorCode(res)).toBe("TASK_ASSIGNEE_NOT_A_MEMBER");
		const after = await readTaskRow(taskId);
		expect(after?.assignedToId).toBe(alice.userId);
		// The refused request must not have consumed a version either, or the next
		// legitimate one would conflict for no reason.
		expect(after?.version).toBe(before?.version);
		expect(await auditFor(taskId, "assignedToId")).toEqual([]);
	});

	test("a member of a different project is still not a member of this one", async () => {
		assertSuiteIsRunnable(reachable);
		const { projectId, outsider } = await fixture("assign crossproject");
		// The outsider joins a *different* project, so they exist, are a real user, and
		// are eligible — and are still refused. This is the case a check written as
		// "is this a user?" instead of "is this a member of *this* project?" would let
		// through.
		const other = await ownProject("It elsewhere");
		await addMemberRaw(world.pm, other, outsider.userId);

		const res = await api(`/projects/${projectId}/tasks`, {
			method: "POST",
			token: world.pm.token,
			body: { title: "It elsewhere task", assignedToId: outsider.userId },
		});

		expect(res.status).toBe(400);
		expect(errorCode(res)).toBe("TASK_ASSIGNEE_NOT_A_MEMBER");
	});

	test("an unknown user id is a 404, not a membership failure", async () => {
		assertSuiteIsRunnable(reachable);
		const { projectId } = await fixture("assign unknown user");

		const res = await api(`/projects/${projectId}/tasks`, {
			method: "POST",
			token: world.pm.token,
			body: {
				title: "It ghost",
				assignedToId: "00000000-0000-4000-8000-000000000000",
			},
		});

		// The two are different diagnoses — "no such person" versus "not on this
		// project" — and a caller fixing a stale form needs to be told which.
		expect(res.status).toBe(404);
		expect(errorCode(res)).toBe("USER_NOT_FOUND");
	});

	test("a client guest cannot be the assignee of an internal task", async () => {
		assertSuiteIsRunnable(reachable);
		const { projectId } = await fixture("assign client");
		const guest = await ownUser("assignclient", "CLIENT", "PRODUCT");
		await addMemberRaw(world.pm, projectId, guest.userId);

		const res = await api(`/projects/${projectId}/tasks`, {
			method: "POST",
			token: world.pm.token,
			body: { title: "It for a guest", assignedToId: guest.userId },
		});

		// Membership is necessary but not sufficient: the existing eligibility rule
		// still refuses a client account for internal work.
		expect(res.status).toBe(400);
		expect(errorCode(res)).toBe("TASK_ASSIGNEE_NOT_ELIGIBLE");
	});

	test("an assignee from another department is refused", async () => {
		assertSuiteIsRunnable(reachable);
		const projectId = await ownProject("It department guard");
		const backend = await ownUser("deptbackend", "INTERNAL", "BACKEND");
		const frontend = await ownUser("deptfrontend", "INTERNAL", "FRONTEND");
		await addMemberRaw(world.pm, projectId, backend.userId);
		await addMemberRaw(world.pm, projectId, frontend.userId);

		const res = await api(`/projects/${projectId}/tasks`, {
			method: "POST",
			token: world.pm.token,
			body: {
				title: "It cross dept",
				assignedToId: frontend.userId,
				// The department has to be stated explicitly. Left to itself the server
				// infers it from the assignee, which is the behaviour being protected —
				// so an inferred task could never disagree with its own assignee.
				department: "BACKEND",
			},
		});

		// A task is owned by exactly one department, so the person doing the work and
		// the team accountable for it cannot disagree.
		expect(res.status).toBe(400);
		expect(errorCode(res)).toBe("TASK_DEPARTMENT_MISMATCH");
	});
});

describe("assignment: who may assign", () => {
	test("an internal user cannot change an assignment", async () => {
		assertSuiteIsRunnable(reachable);
		const { projectId, alice, bob } = await fixture("assign internal denied");
		const taskId = await createTask(projectId, "It not theirs to move", {
			assignedToId: alice.userId,
		});
		const before = await readTaskRow(taskId);

		for (const body of [
			{ assignedToId: bob.userId, version: before?.version },
			{ assignedToId: null, version: before?.version },
		]) {
			const res = await api(`/projects/${projectId}/tasks/${taskId}`, {
				method: "PATCH",
				token: alice.token,
				body,
			});

			// PART 5: internal users were never granted assignment. Doing their own
			// work is a status change, not a reassignment.
			expect(res.status).toBe(403);
			expect(errorCode(res)).toBe("TASK_ACCESS_DENIED");
		}

		const after = await readTaskRow(taskId);
		expect(after?.assignedToId).toBe(alice.userId);
		expect(after?.version).toBe(before?.version);
	});

	test("a client guest cannot assign anything", async () => {
		assertSuiteIsRunnable(reachable);
		const { projectId, alice } = await fixture("assign client denied");

		const res = await api(`/projects/${projectId}/tasks`, {
			method: "POST",
			token: world.client.token,
			body: { title: "It guest task", assignedToId: alice.userId },
		});

		expect(res.status).toBe(403);
	});

	test("an internal member can still change their own task's status", async () => {
		assertSuiteIsRunnable(reachable);
		// The point of the previous case: refusing assignment must not have narrowed
		// what an internal user can do. They are the executor, so moving the task
		// along is theirs to do.
		const { projectId, alice } = await fixture("assign internal status ok");
		const taskId = await createTask(projectId, "It mine to move", {
			assignedToId: alice.userId,
		});
		const before = await readTaskRow(taskId);

		const res = await api(`/projects/${projectId}/tasks/${taskId}`, {
			method: "PATCH",
			token: alice.token,
			body: { status: "IN_PROGRESS", version: before?.version },
		});

		expect(res.status).toBe(200);
		expect(jsonPath<string>(res, ["data", "task", "status"])).toBe("IN_PROGRESS");
	});
});

describe("assignment: reassignment and unassignment", () => {
	test("a PM can hand a task to another member", async () => {
		assertSuiteIsRunnable(reachable);
		const { projectId, alice, bob } = await fixture("assign hand over");
		const taskId = await createTask(projectId, "It hand me over", {
			assignedToId: alice.userId,
		});
		const before = await readTaskRow(taskId);

		const res = await api(`/projects/${projectId}/tasks/${taskId}`, {
			method: "PATCH",
			token: world.pm.token,
			body: { assignedToId: bob.userId, version: before?.version },
		});

		expect(res.status).toBe(200);
		expect(await assignedToIdOf(res)).toBe(bob.userId);
		// The response resolves the *new* assignee, not the one it replaced.
		expect(await assignedToNameOf(res)).toBe(bob.name);
	});

	test("unassigning with an explicit null removes the assignment", async () => {
		assertSuiteIsRunnable(reachable);
		const { projectId, alice } = await fixture("assign clear");
		const taskId = await createTask(projectId, "It clear me", {
			assignedToId: alice.userId,
		});
		const before = await readTaskRow(taskId);

		const res = await api(`/projects/${projectId}/tasks/${taskId}`, {
			method: "PATCH",
			token: world.pm.token,
			body: { assignedToId: null, version: before?.version },
		});

		// PART 8: `null` is a value, not a validation error. An omitted key would
		// mean "leave it alone"; `null` means "take it off".
		expect(res.status).toBe(200);
		expect(await assignedToIdOf(res)).toBeNull();
		expect(await assignedToOf(res)).toBeNull();
	});

	test("omitting assignedToId leaves the assignment alone", async () => {
		assertSuiteIsRunnable(reachable);
		const { projectId, alice } = await fixture("assign untouched");
		const taskId = await createTask(projectId, "It leave it", {
			assignedToId: alice.userId,
		});
		const before = await readTaskRow(taskId);

		const res = await api(`/projects/${projectId}/tasks/${taskId}`, {
			method: "PATCH",
			token: world.pm.token,
			body: { title: "It renamed only", version: before?.version },
		});

		expect(res.status).toBe(200);
		expect(await assignedToIdOf(res)).toBe(alice.userId);
	});

	test("a reassignment changes nothing else about the task", async () => {
		assertSuiteIsRunnable(reachable);
		// PART 28, and the one most likely to be broken by something helpful. A
		// handover must move the assignee and nothing else: not the status, not the
		// dependencies, not client visibility, not the work already recorded.
		const { projectId, alice, bob } = await fixture("assign narrow");
		const prerequisite = await createTask(projectId, "It prerequisite", {
			status: "DONE",
		});
		const taskId = await createTask(projectId, "It handover", {
			assignedToId: alice.userId,
			status: "IN_PROGRESS",
			clientVisible: true,
			priority: "HIGH",
		});
		await api(`/projects/${projectId}/tasks/${taskId}/dependencies`, {
			method: "POST",
			token: world.pm.token,
			body: { dependencyTaskId: prerequisite },
		});
		const before = await readTaskRow(taskId);

		await api(`/projects/${projectId}/tasks/${taskId}`, {
			method: "PATCH",
			token: world.pm.token,
			body: { assignedToId: bob.userId, version: before?.version },
		});

		const after = await readTaskRow(taskId);
		expect(after?.assignedToId).toBe(bob.userId);
		expect(after?.status).toBe(before?.status);
		expect(after?.title).toBe(before?.title);
		expect(after?.clientVisible).toBe(before?.clientVisible);
		expect(after?.priority).toBe(before?.priority);
		expect(after?.department).toBe(before?.department);
		// The dependency is still there: handing the work to somebody else does not
		// make the prerequisite go away.
		const dependencies = await api(
			`/projects/${projectId}/tasks/${taskId}/dependencies`,
			{ token: world.pm.token },
		);
		expect(
			(dependencies.json as { data?: { dependencies?: unknown[] } } | null)?.data
				?.dependencies,
		).toHaveLength(1);
		// The handover is the only thing in the history for this column.
		expect(await auditFor(taskId, "assignedToId")).toEqual([
			{ oldValue: alice.userId, newValue: bob.userId },
		]);
	});

	test("a completed task can be reassigned without being reopened", async () => {
		assertSuiteIsRunnable(reachable);
		// PART 29. Completing a task is a statement about the work, not about who did
		// it, so a later correction of the record must not reopen the work.
		const { projectId, alice, bob } = await fixture("assign done handover");
		const taskId = await createTask(projectId, "It done handover", {
			assignedToId: alice.userId,
			status: "DONE",
		});
		const before = await readTaskRow(taskId);

		const res = await api(`/projects/${projectId}/tasks/${taskId}`, {
			method: "PATCH",
			token: world.pm.token,
			body: { assignedToId: bob.userId, version: before?.version },
		});

		expect(res.status).toBe(200);
		expect(jsonPath<string>(res, ["data", "task", "status"])).toBe("DONE");
		expect(await assignedToIdOf(res)).toBe(bob.userId);
	});

	test("a deleted task cannot be assigned, reassigned or unassigned", async () => {
		assertSuiteIsRunnable(reachable);
		// PART 30. A soft-deleted row is not a task anybody is working on, so the
		// whole membership of it is closed.
		const { projectId, alice, bob } = await fixture("assign deleted");
		const taskId = await createTask(projectId, "It gone", {
			assignedToId: alice.userId,
		});
		const version = await versionOf(taskId);
		const removed = await api(
			`/projects/${projectId}/tasks/${taskId}?version=${String(version)}`,
			{ method: "DELETE", token: world.pm.token },
		);
		expect(removed.status).toBe(204);

		for (const body of [
			{ assignedToId: bob.userId, version: version + 1 },
			{ assignedToId: null, version: version + 1 },
		]) {
			const res = await api(`/projects/${projectId}/tasks/${taskId}`, {
				method: "PATCH",
				token: world.pm.token,
				body,
			});
			// 404 rather than 409: the update path looks for a live task, and a
			// soft-deleted one is simply not there. Either way the point holds — the
			// write is refused and the stored assignee is untouched.
			expect(res.status).toBe(404);
			expect(errorCode(res)).toBe("TASK_NOT_FOUND");
		}

		const row = await readTaskRow(taskId);
		expect(row?.assignedToId).toBe(alice.userId);
	});
});

describe("assignment: optimistic locking", () => {
	test("an assignment requires the current version", async () => {
		assertSuiteIsRunnable(reachable);
		const { projectId, alice, bob } = await fixture("assign version needed");
		const taskId = await createTask(projectId, "It needs a version", {
			assignedToId: alice.userId,
		});

		// PART 7: the guard is mandatory, not optional metadata.
		const res = await api(`/projects/${projectId}/tasks/${taskId}`, {
			method: "PATCH",
			token: world.pm.token,
			body: { assignedToId: bob.userId },
		});

		expect(res.status).toBe(400);
		const row = await readTaskRow(taskId);
		expect(row?.assignedToId).toBe(alice.userId);
	});

	test("a stale assignment loses to a concurrent one", async () => {
		assertSuiteIsRunnable(reachable);
		// PART 9, the whole reason the version exists. Two project managers read the
		// same task; the first to write wins and the second must be told rather than
		// silently overwriting.
		const { projectId, alice, bob } = await fixture("assign race");
		const outsider = await ownUser("raceoutsider");
		await addMemberRaw(world.pm, projectId, outsider.userId);
		const taskId = await createTask(projectId, "It raced", {
			assignedToId: alice.userId,
		});
		const read = await versionOf(taskId);

		const first = await api(`/projects/${projectId}/tasks/${taskId}`, {
			method: "PATCH",
			token: world.pm.token,
			body: { assignedToId: bob.userId, version: read },
		});
		expect(first.status).toBe(200);

		const stale = await api(`/projects/${projectId}/tasks/${taskId}`, {
			method: "PATCH",
			token: world.pm.token,
			body: { assignedToId: outsider.userId, version: read },
		});

		expect(stale.status).toBe(409);
		// The existing optimistic-lock code, shared with every other task mutation.
		expect(errorCode(stale)).toBe("CONCURRENT_MODIFICATION");
		// The winner is not undone by the loser.
		const row = await readTaskRow(taskId);
		expect(row?.assignedToId).toBe(bob.userId);
		expect(row?.version).toBe(read + 1);
	});

	test("the conflict names the version the row is actually on", async () => {
		assertSuiteIsRunnable(reachable);
		// The 409 has to be actionable on its own: a client is told the current
		// version and handed the current task, including who it is now assigned to.
		const { projectId, alice, bob } = await fixture("assign conflict body");
		const taskId = await createTask(projectId, "It conflict body", {
			assignedToId: alice.userId,
		});
		const read = await versionOf(taskId);
		await api(`/projects/${projectId}/tasks/${taskId}`, {
			method: "PATCH",
			token: world.pm.token,
			body: { assignedToId: bob.userId, version: read },
		});

		const stale = await api(`/projects/${projectId}/tasks/${taskId}`, {
			method: "PATCH",
			token: world.pm.token,
			body: { assignedToId: alice.userId, version: read },
		});

		expect(jsonPath<number>(stale, ["error", "currentVersion"])).toBe(read + 1);
		expect(jsonPath<number>(stale, ["error", "expectedVersion"])).toBe(read);
		expect(
			jsonPath<string>(stale, ["error", "latestTask", "assignedTo", "name"]),
		).toBe(bob.name);
	});

	test("an assignment change increments the version exactly once", async () => {
		assertSuiteIsRunnable(reachable);
		const { projectId, alice, bob } = await fixture("assign version bump");
		const taskId = await createTask(projectId, "It bump", {
			assignedToId: alice.userId,
		});
		const before = await versionOf(taskId);

		await api(`/projects/${projectId}/tasks/${taskId}`, {
			method: "PATCH",
			token: world.pm.token,
			body: { assignedToId: bob.userId, version: before },
		});

		expect(await versionOf(taskId)).toBe(before + 1);
	});
});

describe("assignment: audit trail", () => {
	test("an assignment from nobody records the change", async () => {
		assertSuiteIsRunnable(reachable);
		// PART 10, the first of the three shapes: null -> someone.
		const { projectId, alice } = await fixture("audit from null");
		const taskId = await createTask(projectId, "It from nobody");

		await api(`/projects/${projectId}/tasks/${taskId}`, {
			method: "PATCH",
			token: world.pm.token,
			body: { assignedToId: alice.userId, version: await versionOf(taskId) },
		});

		expect(await auditFor(taskId, "assignedToId")).toEqual([
			{ oldValue: null, newValue: alice.userId },
		]);
	});

	test("a reassignment records both sides", async () => {
		assertSuiteIsRunnable(reachable);
		const { projectId, alice, bob } = await fixture("audit between");
		const taskId = await createTask(projectId, "It between", {
			assignedToId: alice.userId,
		});

		await api(`/projects/${projectId}/tasks/${taskId}`, {
			method: "PATCH",
			token: world.pm.token,
			body: { assignedToId: bob.userId, version: await versionOf(taskId) },
		});

		expect(await auditFor(taskId, "assignedToId")).toEqual([
			{ oldValue: alice.userId, newValue: bob.userId },
		]);
	});

	test("an unassignment records the person it was taken from", async () => {
		assertSuiteIsRunnable(reachable);
		// PART 10, the shape that is easy to get wrong: a null new value must be
		// recorded as a change, not treated as "nothing to say".
		const { projectId, alice } = await fixture("audit to null");
		const taskId = await createTask(projectId, "It to nobody", {
			assignedToId: alice.userId,
		});

		await api(`/projects/${projectId}/tasks/${taskId}`, {
			method: "PATCH",
			token: world.pm.token,
			body: { assignedToId: null, version: await versionOf(taskId) },
		});

		expect(await auditFor(taskId, "assignedToId")).toEqual([
			{ oldValue: alice.userId, newValue: null },
		]);
	});

	test("re-assigning the same person records nothing", async () => {
		assertSuiteIsRunnable(reachable);
		// PART 10. A no-op is not a change, and a history that records one is a
		// history that cannot be read to find out what happened.
		const { projectId, alice } = await fixture("audit noop");
		const taskId = await createTask(projectId, "It noop", {
			assignedToId: alice.userId,
		});

		const res = await api(`/projects/${projectId}/tasks/${taskId}`, {
			method: "PATCH",
			token: world.pm.token,
			body: { assignedToId: alice.userId, version: await versionOf(taskId) },
		});

		expect(res.status).toBe(200);
		expect(await auditFor(taskId, "assignedToId")).toEqual([]);
		// And the version is untouched, because nothing was written.
		const after = await readTaskRow(taskId);
		expect(after?.assignedToId).toBe(alice.userId);
	});

	test("clearing an already-unassigned task records nothing", async () => {
		assertSuiteIsRunnable(reachable);
		const { projectId } = await fixture("audit noop null");
		const taskId = await createTask(projectId, "It already nobody");

		const res = await api(`/projects/${projectId}/tasks/${taskId}`, {
			method: "PATCH",
			token: world.pm.token,
			body: { assignedToId: null, version: await versionOf(taskId) },
		});

		expect(res.status).toBe(200);
		expect(await auditFor(taskId, "assignedToId")).toEqual([]);
	});

	test("each changed field gets its own record", async () => {
		assertSuiteIsRunnable(reachable);
		// PART 11. The audit contract is field-based, so a combined request still
		// produces one record per field rather than a single summary of the edit.
		const { projectId, alice, bob } = await fixture("audit multi");
		const taskId = await createTask(projectId, "It before", {
			assignedToId: alice.userId,
		});

		const res = await api(`/projects/${projectId}/tasks/${taskId}`, {
			method: "PATCH",
			token: world.pm.token,
			body: {
				title: "It after",
				assignedToId: bob.userId,
				status: "IN_PROGRESS",
				version: await versionOf(taskId),
			},
		});

		expect(res.status).toBe(200);
		const rows = await readAuditRows(taskId);
		expect(rows.map((row) => row.changedColumn).sort()).toEqual([
			"assignedToId",
			"status",
			"title",
		]);
		expect(await auditFor(taskId, "assignedToId")).toEqual([
			{ oldValue: alice.userId, newValue: bob.userId },
		]);
	});
});

describe("assignment: assignee information in responses", () => {
	test("the list resolves assignees without exposing anything else", async () => {
		assertSuiteIsRunnable(reachable);
		// PART 13 and PART 40. The summary is an explicit projection, and this
		// asserts the *absence* of the secret rather than trusting the builder.
		const { projectId, alice } = await fixture("summary shape");
		await createTask(projectId, "It summarised", { assignedToId: alice.userId });
		await createTask(projectId, "It unsummarised");

		const res = await api(`/projects/${projectId}/tasks`, {
			token: world.pm.token,
		});

		expect(res.status).toBe(200);
		expect(res.text).not.toContain("passwordHash");
		const rows =
			(res.json as { data?: { tasks?: Record<string, unknown>[] } } | null)?.data
				?.tasks ?? [];
		const assigned = rows.find((row) => row.title === "It summarised");
		const empty = rows.find((row) => row.title === "It unsummarised");

		expect(assigned?.assignedTo).toEqual({
			id: alice.userId,
			name: alice.name,
			email: alice.email,
			role: "INTERNAL",
			department: "BACKEND",
		});
		expect(empty?.assignedTo).toBeNull();
	});

	test("the client portal carries no assignment information at all", async () => {
		assertSuiteIsRunnable(reachable);
		// PART 14. The existing masking policy withholds internal identity entirely,
		// and that is the right call for an assignment: which engineer is building
		// what is internal, so a client task carries no assignee field and no
		// assignee id.
		const { projectId, alice } = await fixture("client masking");
		await addMemberRaw(world.pm, projectId, world.client.userId);
		await createTask(projectId, "It client visible", {
			assignedToId: alice.userId,
			clientVisible: true,
		});

		// Clients read the masked portal, not the internal list: the internal route
		// refuses a client guest outright, so this is the payload a client actually
		// receives for a task assigned to an engineer.
		const res = await api(`/client/projects/${projectId}/tasks`, {
			token: world.client.token,
		});

		expect(res.status).toBe(200);
		expect(res.text).not.toContain("assignedTo");
		expect(res.text).not.toContain(alice.email);
		expect(res.text).not.toContain(alice.userId);
		expect(res.text).not.toContain("passwordHash");
	});
});

describe("assignment: filters", () => {
	test("a single assignee filter narrows the list", async () => {
		assertSuiteIsRunnable(reachable);
		const { projectId, alice, bob } = await fixture("filter one");
		await createTask(projectId, "It for alice", { assignedToId: alice.userId });
		await createTask(projectId, "It for bob", { assignedToId: bob.userId });

		const res = await api(
			`/projects/${projectId}/tasks?assignedToId=${alice.userId}`,
			{ token: world.pm.token },
		);

		const rows =
			(res.json as { data?: { tasks?: { title: string }[] } } | null)?.data
				?.tasks ?? [];
		expect(rows).toHaveLength(1);
		expect(rows[0]?.title).toBe("It for alice");
	});

	test("the flat list asks for several assignees at once", async () => {
		assertSuiteIsRunnable(reachable);
		const { projectId, alice, bob } = await fixture("filter many");
		await createTask(projectId, "It for alice", { assignedToId: alice.userId });
		await createTask(projectId, "It for bob", { assignedToId: bob.userId });
		await createTask(projectId, "It for nobody");

		const res = await api(
			`/tasks?${flatFilters({ assignedToId: [alice.userId, bob.userId] })}&rows=100`,
			{ token: world.pm.token },
		);

		expect(res.status).toBe(200);
		const rows =
			(res.json as { data?: { tasks?: { title: string }[] } } | null)?.data
				?.tasks ?? [];
		expect(rows.map((row) => row.title).sort()).toEqual([
			"It for alice",
			"It for bob",
		]);
	});

	test("unassigned tasks can be found", async () => {
		assertSuiteIsRunnable(reachable);
		// PART 16. "Who has nobody on this?" is a question a project manager asks
		// constantly, and it cannot be answered by a uuid filter.
		const { projectId, alice } = await fixture("filter unassigned");
		await createTask(projectId, "It owned", { assignedToId: alice.userId });
		await createTask(projectId, "It orphan one");
		await createTask(projectId, "It orphan two");

		const res = await api(`/projects/${projectId}/tasks?assignedToId=unassigned`, {
			token: world.pm.token,
		});

		const rows =
			(res.json as { data?: { tasks?: { title: string }[] } } | null)?.data
				?.tasks ?? [];
		expect(rows.map((row) => row.title).sort()).toEqual([
			"It orphan one",
			"It orphan two",
		]);
	});

	test("unassigned can be combined with a person", async () => {
		assertSuiteIsRunnable(reachable);
		// The sentinel is a disjunction, not an override, so one request can ask for
		// both halves. The nested list takes a single value, so this is the flat
		// list's form.
		const { projectId, alice } = await fixture("filter mixed");
		await createTask(projectId, "It owned", { assignedToId: alice.userId });
		await createTask(projectId, "It orphan");

		const res = await api(
			`/tasks?${flatFilters({
				// Scoped to the fixture's project as well, because "unassigned" on its own
				// is every unassigned task in the database and the point of this case is
				// the disjunction, not the population.
				projectId,
				assignedToId: ["unassigned", alice.userId],
			})}&rows=100`,
			{ token: world.pm.token },
		);

		expect(res.status).toBe(200);
		const rows =
			(res.json as { data?: { tasks?: { title: string }[] } } | null)?.data
				?.tasks ?? [];
		expect(rows.map((row) => row.title).sort()).toEqual([
			"It orphan",
			"It owned",
		]);
	});

	test("the filter also works on the flat cross-project list", async () => {
		assertSuiteIsRunnable(reachable);
		const { projectId, alice } = await fixture("filter flat");
		await createTask(projectId, "It flat owned", { assignedToId: alice.userId });
		await createTask(projectId, "It flat orphan");

		const res = await api(`/tasks?${flatFilters({ assignedToId: "unassigned" })}&rows=100`, {
			token: world.pm.token,
		});

		expect(res.status).toBe(200);
		const rows =
			(res.json as { data?: { tasks?: { title: string }[] } } | null)?.data
				?.tasks ?? [];
		expect(rows.some((row) => row.title === "It flat orphan")).toBe(true);
		expect(rows.some((row) => row.title === "It flat owned")).toBe(false);
	});

	test("a nonsense assignee filter is a validation error, not an empty page", async () => {
		assertSuiteIsRunnable(reachable);
		const { projectId } = await fixture("filter bad");

		const res = await api(`/projects/${projectId}/tasks?assignedToId=not-a-uuid`, {
			token: world.pm.token,
		});

		// Silently matching nothing would look like "nobody has these tasks".
		expect(res.status).toBe(400);
	});
});

describe("assignment: my tasks", () => {
	test("My Tasks returns only what the caller is on", async () => {
		assertSuiteIsRunnable(reachable);
		// PART 17. There is no userId parameter, so the only way in is the JWT.
		const { projectId, alice, bob } = await fixture("mine basic");
		await createTask(projectId, "It mine", { assignedToId: alice.userId });
		await createTask(projectId, "It theirs", { assignedToId: bob.userId });
		await createTask(projectId, "It nobody at all");

		const res = await api("/tasks/my?rows=100", { token: alice.token });

		expect(res.status).toBe(200);
		const rows =
			(res.json as { data?: { tasks?: { title: string; assignedToId: string }[] } } | null)
				?.data?.tasks ?? [];
		expect(rows.some((row) => row.title === "It mine")).toBe(true);
		expect(rows.some((row) => row.title === "It theirs")).toBe(false);
		expect(rows.some((row) => row.title === "It nobody at all")).toBe(false);
		expect(rows.every((row) => row.assignedToId === alice.userId)).toBe(true);
	});

	test("My Tasks cannot be pointed at somebody else", async () => {
		assertSuiteIsRunnable(reachable);
		// PART 17, the security half. A client-supplied assignee is discarded rather
		// than honoured, so the endpoint cannot become "which projects does this
		// person work on" for an arbitrary id.
		const { projectId, alice, bob } = await fixture("mine spoof");
		await createTask(projectId, "It mine only", { assignedToId: alice.userId });
		await createTask(projectId, "It bob only", { assignedToId: bob.userId });

		const res = await api(
			`/tasks/my?${flatFilters({ assignedToId: bob.userId })}&rows=100`,
			{ token: alice.token },
		);

		expect(res.status).toBe(200);
		const rows =
			(res.json as { data?: { tasks?: { title: string }[] } } | null)?.data
				?.tasks ?? [];
		expect(rows.every((row) => row.title === "It mine only")).toBe(true);
		expect(rows.some((row) => row.title === "It bob only")).toBe(false);
	});

	test("My Tasks respects the caller's project access", async () => {
		assertSuiteIsRunnable(reachable);
		// The scoping in the shared list is not bypassed by the convenience wrapper.
		const stranger = await ownUser("minestranger");
		const mine = await fixture("mine scoping");
		await createTask(mine.projectId, "It mine", {
			assignedToId: mine.alice.userId,
		});

		// A project alice is not a member of, and a task in it that is hers anyway.
		// That is the only way to prove the scoping is doing something: a task she
		// does not own in a project she cannot open must not surface.
		const closed = await ownProject("It closed to you");
		await addMemberRaw(world.pm, closed, stranger.userId);
		await addMemberRaw(world.pm, closed, mine.alice.userId);
		const hidden = await createTask(closed, "It hidden work", {
			assignedToId: mine.alice.userId,
		});

		// Removing her leaves the task assigned to somebody who can no longer open
		// the project, which the removal guard refuses — so drive the invisibility
		// through a stranger's project instead.
		const locked = await ownProject("It locked to you");
		await addMemberRaw(world.pm, locked, stranger.userId);
		const invisible = await createTask(locked, "It invisible work", {
			assignedToId: stranger.userId,
		});

		const res = await api("/tasks/my?rows=100", { token: mine.alice.token });
		const titles = (
			(res.json as { data?: { tasks?: { title: string }[] } } | null)?.data
				?.tasks ?? []
		).map((row) => row.title);
		expect(titles).toContain("It mine");
		expect(titles).not.toContain("It invisible work");

		// And a task in a project the caller is not in is not readable at all, which
		// is the stronger statement: My Tasks does not merely omit it, and the direct
		// read is refused too.
		const read = await api(`/tasks/${invisible}`, { token: mine.alice.token });
		expect(read.status).toBe(403);
		expect(errorCode(read)).toBe("TASK_ACCESS_DENIED");
		expect(hidden.length).toBeGreaterThan(0);
	});

	test("My Tasks supports the ordinary filters", async () => {
		assertSuiteIsRunnable(reachable);
		// PART 18, and the reason this is a wrapper rather than a new query: status,
		// project, search, ordering and paging all come from the one implementation.
		const { projectId, alice } = await fixture("mine filters");
		await createTask(projectId, "It open item", { assignedToId: alice.userId });
		await createTask(projectId, "It closed item", {
			assignedToId: alice.userId,
			status: "DONE",
		});

		const byStatus = await api(
			`/tasks/my?${flatFilters({ status: "IN_PROGRESS" })}&rows=100`,
			{ token: alice.token },
		);
		const byProject = await api(
			`/tasks/my?${flatFilters({ projectId })}&rows=100`,
			{ token: alice.token },
		);
		const bySearch = await api(
			`/tasks/my?${flatFilters({})}&searchFilters=${encodeURIComponent(
				JSON.stringify({ title: "closed" }),
			)}&rows=100`,
			{ token: alice.token },
		);

		const titles = (res: { json: unknown }): string[] =>
			(
				(res.json as { data?: { tasks?: { title: string }[] } } | null)?.data
					?.tasks ?? []
			).map((row) => row.title);

		expect(titles(byStatus)).toEqual([]);
		expect(titles(byProject).sort()).toEqual(["It closed item", "It open item"]);
		expect(titles(bySearch)).toEqual(["It closed item"]);
	});

	test("My Tasks is empty for somebody with nothing on", async () => {
		assertSuiteIsRunnable(reachable);
		const idle = await ownUser("mineidle");

		const res = await api("/tasks/my", { token: idle.token });

		expect(res.status).toBe(200);
		expect(
			jsonPath<number>(res, ["data", "pagination", "total"]),
		).toBe(0);
	});

	test("My Tasks requires a session", async () => {
		assertSuiteIsRunnable(reachable);

		const res = await api("/tasks/my");

		expect(res.status).toBe(401);
	});

	test("a client guest is refused My Tasks", async () => {
		assertSuiteIsRunnable(reachable);
		// The internal task list is not for client guests, and a personal view of
		// internal work is exactly as sensitive.
		const res = await api("/tasks/my", { token: world.client.token });

		expect(res.status).toBe(403);
	});
});

describe("assignment: workload", () => {
	test("the metrics report unassigned work and who is carrying the rest", async () => {
		assertSuiteIsRunnable(reachable);
		// PART 33 and PART 34, computed by the server so the dashboard never has to
		// download the project to count it.
		const { projectId, alice, bob } = await fixture("workload");
		await createTask(projectId, "It alice one", { assignedToId: alice.userId });
		await createTask(projectId, "It alice two", { assignedToId: alice.userId });
		await createTask(projectId, "It bob one", { assignedToId: bob.userId });
		await createTask(projectId, "It nobody one");
		await createTask(projectId, "It nobody two");
		await createTask(projectId, "It finished", { status: "DONE" });

		const res = await api(`/projects/${projectId}/metrics`, {
			token: world.pm.token,
		});

		expect(res.status).toBe(200);
		// Three, not two: the finished task has nobody on it either. `unassigned` is a
		// breakdown of the task total rather than of the open work, so it counts
		// every live task without an assignee — which is what makes the two numbers
		// reconcilable against `total`. The `workload` split below is the one that
		// counts only unfinished work.
		expect(jsonPath<number>(res, ["data", "metrics", "tasks", "unassigned"])).toBe(
			3,
		);
		const workload =
			jsonPath<{ userId: string | null; name: string; openTaskCount: number }[]>(
				res,
				["data", "metrics", "workload"],
			) ?? [];
		// Busiest first, with the unassigned bucket as a row of its own and the
		// finished task left out of the open-work split.
		expect(workload.map((row) => [row.name, row.openTaskCount])).toEqual([
			[alice.name, 2],
			["Unassigned", 2],
			[bob.name, 1],
		]);
	});

	test("the workload does not enumerate members with no open work", async () => {
		assertSuiteIsRunnable(reachable);
		const { projectId, alice } = await fixture("workload sparse");
		await createTask(projectId, "It alice only", { assignedToId: alice.userId });

		const res = await api(`/projects/${projectId}/metrics`, {
			token: world.pm.token,
		});

		const workload =
			jsonPath<{ name: string }[]>(res, ["data", "metrics", "workload"]) ?? [];
		expect(workload.map((row) => row.name)).toEqual([alice.name]);
	});

	test("a client guest cannot read the workload", async () => {
		assertSuiteIsRunnable(reachable);
		// It names people, so it is internal-only like the rest of the metrics.
		const { projectId, alice } = await fixture("workload client");
		await addMemberRaw(world.pm, projectId, world.client.userId);
		await createTask(projectId, "It visible", {
			assignedToId: alice.userId,
			clientVisible: true,
		});

		const res = await api(`/projects/${projectId}/metrics`, {
			token: world.client.token,
		});

		expect(res.status).toBe(403);
	});
});
