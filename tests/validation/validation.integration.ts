import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import {
	type World,
	api,
	assertSuiteIsRunnable,
	buildWorld,
	cleanupFixtures,
	createTask,
	databaseIsReachable,
	errorCode,
	jsonPath,
	readTaskRow,
} from "../helpers/harness";

// ---------------------------------------------------------------------------
// Input validation and mass assignment protection (assessment sections 25
// and 26).
//
// Two rules are being checked here.
//
// Validation: a malformed body is refused with a 400 and a stable code, before
// any work is done. The cases are the ones a caller actually gets wrong, not
// synthetic ones.
//
// Mass assignment: a caller cannot write a field it does not own. The task
// schemas are strict objects, so an unexpected key is rejected outright rather
// than quietly dropped, and the per-field authorization layer then decides what
// a valid key may be changed to. The dangerous fields are the ones that would
// let a caller move work between tenants or forge provenance: `projectId`,
// `createdBy`, `id`, `version`, `deletedAt`.
// ---------------------------------------------------------------------------

let reachable = false;
let world: World;

beforeAll(async () => {
	reachable = await databaseIsReachable();
	if (!reachable) {
		return;
	}
	world = await buildWorld();
});

afterAll(cleanupFixtures);

async function versionOf(taskId: string): Promise<number> {
	const row = await readTaskRow(taskId);
	if (!row) {
		throw new Error(`fixture: task ${taskId} disappeared`);
	}
	return row.version;
}

describe("input validation and mass assignment", () => {
	test("the suite is skipped loudly rather than passing on an empty database", () => {
		assertSuiteIsRunnable(reachable);
	});

	describe("create validation", () => {
		test("a body missing its required fields is refused", async () => {
			for (const body of [{}, { title: "No project" }, { projectId: world.project.id }]) {
				const res = await api("/tasks", {
					method: "POST",
					token: world.pm.token,
					body,
				});
				expect(res.status).toBe(400);
				expect(errorCode(res)).toBe("INVALID_REQUEST");
			}
		});

		test("an invalid uuid is refused", async () => {
			const res = await api("/tasks", {
				method: "POST",
				token: world.pm.token,
				body: { projectId: "not-a-uuid", title: "Bad project id" },
			});
			expect(res.status).toBe(400);
		});

		test("an unknown enum member is refused", async () => {
			for (const body of [
				{ projectId: world.project.id, title: "Bad status", status: "STARTED" },
				{ projectId: world.project.id, title: "Bad priority", priority: "CRITICAL" },
				{ projectId: world.project.id, title: "Bad department", department: "MARKETING" },
				// CLIENT describes a user, never a unit of delivery work.
				{ projectId: world.project.id, title: "Bad department", department: "CLIENT" },
			]) {
				const res = await api("/tasks", {
					method: "POST",
					token: world.pm.token,
					body,
				});
				expect(res.status).toBe(400);
				expect(errorCode(res)).toBe("INVALID_REQUEST");
			}
		});

		test("an empty or over-long title is refused", async () => {
			for (const title of ["", "   ", "x".repeat(201)]) {
				const res = await api("/tasks", {
					method: "POST",
					token: world.pm.token,
					body: { projectId: world.project.id, title },
				});
				expect(res.status).toBe(400);
			}
		});

		test("an assignee who is not a project member is refused", async () => {
			const res = await api("/tasks", {
				method: "POST",
				token: world.pm.token,
				body: {
					projectId: world.project.id,
					title: "Assigned to a stranger",
					assignedToId: world.foreignClient.userId,
				},
			});

			expect(res.status).toBe(400);
			expect(errorCode(res)).toBe("TASK_ASSIGNEE_NOT_A_MEMBER");
		});

		test("a client guest can never be an assignee", async () => {
			const res = await api("/tasks", {
				method: "POST",
				token: world.pm.token,
				body: {
					projectId: world.project.id,
					title: "Assigned to a client",
					assignedToId: world.client.userId,
				},
			});

			expect(res.status).toBe(400);
			expect(errorCode(res)).toBe("TASK_ASSIGNEE_NOT_ELIGIBLE");
		});

		test("an assignee from a different department is refused", async () => {
			const res = await api("/tasks", {
				method: "POST",
				token: world.pm.token,
				body: {
					projectId: world.project.id,
					title: "Mismatched department",
					assignedToId: world.otherEngineer.userId,
					department: "BACKEND",
				},
			});

			expect(res.status).toBe(400);
			expect(errorCode(res)).toBe("TASK_DEPARTMENT_MISMATCH");
		});
	});

	describe("mass assignment on create", () => {
		test("server owned fields cannot be supplied", async () => {
			const attempts: readonly Record<string, unknown>[] = [
				{ id: "11111111-1111-4111-8111-111111111111" },
				{ version: 42 },
				{ createdAt: "2020-01-01T00:00:00.000Z" },
				{ updatedAt: "2020-01-01T00:00:00.000Z" },
				{ deletedAt: null },
				{ createdBy: world.pm.userId },
			];

			for (const extra of attempts) {
				const res = await api("/tasks", {
					method: "POST",
					token: world.pm.token,
					body: { projectId: world.project.id, title: "Mass assignment", ...extra },
				});
				expect(res.status).toBe(400);
				expect(errorCode(res)).toBe("INVALID_REQUEST");
			}
		});

		test("a derived blocking field cannot be forced", async () => {
			for (const extra of [{ isBlocked: false }, { blockedBy: [] }]) {
				const res = await api("/tasks", {
					method: "POST",
					token: world.pm.token,
					body: { projectId: world.project.id, title: "Forced blocking", ...extra },
				});
				expect(res.status).toBe(400);
			}
		});

		test("a project the caller cannot reach is not adopted through the body", async () => {
			// The nested route takes the project from the path, so a body value
			// cannot redirect the write into another tenant.
			const res = await api(`/projects/${world.project.id}/tasks`, {
				method: "POST",
				token: world.pm.token,
				body: {
					title: "Redirected",
					projectId: world.foreignProject.id,
				},
			});

			// `projectId` is not a field of the nested create body.
			expect(res.status).toBe(400);
		});
	});

	describe("mass assignment on update", () => {
		test("an engineer cannot set fields the schema accepts but the role does not", async () => {
			const taskId = await createTask(world.pm, world.project.id, "Guarded fields", {
				assignedToId: world.engineer.userId,
				department: "BACKEND",
				description: "original",
			});

			const attempts: readonly [string, unknown][] = [
				["description", "rewritten"],
				["assignedToId", world.otherEngineer.userId],
				["priority", "URGENT"],
				["department", "PRODUCT"],
				["clientVisible", true],
			];

			for (const [field, value] of attempts) {
				const res = await api(`/tasks/${taskId}`, {
					method: "PATCH",
					token: world.engineer.token,
					body: { version: await versionOf(taskId), [field]: value },
				});
				expect(res.status).toBe(403);
				expect(errorCode(res)).toBe("TASK_ACCESS_DENIED");
			}

			// None of the refusals changed the row.
			const row = await readTaskRow(taskId);
			expect(row?.description).toBe("original");
			expect(row?.priority).toBe("MEDIUM");
			expect(row?.clientVisible).toBe(false);
		});

		test("a project manager still cannot move a task to another project", async () => {
			const taskId = await createTask(world.pm, world.project.id, "Stays put");

			for (const field of ["projectId", "createdBy", "id", "deletedAt"]) {
				const res = await api(`/tasks/${taskId}`, {
					method: "PATCH",
					token: world.pm.token,
					body: { version: await versionOf(taskId), [field]: "anything" },
				});
				expect(res.status).toBe(400);
			}

			const row = await readTaskRow(taskId);
			expect(row?.projectId).toBe(world.project.id);
		});

		test("a body with no mutable field is refused", async () => {
			const taskId = await createTask(world.pm, world.project.id, "Nothing to change");

			const res = await api(`/tasks/${taskId}`, {
				method: "PATCH",
				token: world.pm.token,
				body: { version: await versionOf(taskId) },
			});

			expect(res.status).toBe(400);
		});

		test("the version cannot be set to a value that skips the lock", async () => {
			const taskId = await createTask(world.pm, world.project.id, "Lock cannot be skipped");
			const before = await versionOf(taskId);

			// A large but well formed version matches no row, so it is a conflict
			// rather than a way to jump the counter.
			const res = await api(`/tasks/${taskId}`, {
				method: "PATCH",
				token: world.pm.token,
				body: { version: 9999, title: "Skipped ahead" },
			});

			expect(res.status).toBe(409);
			expect((await readTaskRow(taskId))?.version).toBe(before);
		});
	});

	describe("delete input", () => {
		test("the version is required and must be a positive integer", async () => {
			const taskId = await createTask(world.pm, world.project.id, "Delete validation");

			for (const query of ["", "?version=0", "?version=-2", "?version=abc", "?force=true"]) {
				const res = await api(`/tasks/${taskId}${query}`, {
					method: "DELETE",
					token: world.pm.token,
				});
				expect(res.status).toBe(400);
			}
		});
	});

	describe("error bodies are safe and consistent", () => {
		test("a validation failure names the offending field but not the internals", async () => {
			const res = await api("/tasks", {
				method: "POST",
				token: world.pm.token,
				body: { projectId: world.project.id, title: "" },
			});

			expect(res.status).toBe(400);
			expect(jsonPath<boolean>(res, ["success"])).toBe(false);
			expect(typeof jsonPath(res, ["error", "code"])).toBe("string");
			expect(typeof jsonPath(res, ["error", "requestId"])).toBe("string");
			expect(res.text.toLowerCase()).not.toContain("postgres");
			expect(res.text.toLowerCase()).not.toContain("select ");
		});

		test("an unauthenticated write is refused before validation", async () => {
			const res = await api("/tasks", {
				method: "POST",
				body: { projectId: world.project.id, title: "No token" },
			});

			// 401, not 400: the caller has not established who they are.
			expect(res.status).toBe(401);
		});

		test("a body larger than the limit is refused", async () => {
			const res = await api("/tasks", {
				method: "POST",
				token: world.pm.token,
				rawBody: JSON.stringify({
					projectId: world.project.id,
					title: "Big",
					description: "x".repeat(2 * 1024 * 1024),
				}),
			});

			expect(res.status).toBe(413);
		});
	});
});
