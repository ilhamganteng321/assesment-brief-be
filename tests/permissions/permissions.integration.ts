import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import {
	type World,
	addDependency,
	api,
	assertSuiteIsRunnable,
	buildWorld,
	cleanupFixtures,
	createTask,
	databaseIsReachable,
	errorCode,
	readTaskRow,
} from "../helpers/harness";

// ---------------------------------------------------------------------------
// Role and attribute based access control (assessment sections 4, 5 and 27).
//
// Every check goes through the HTTP API with a real token. The frontend hides
// controls it thinks a role cannot use, but hiding is not enforcement, so
// nothing here depends on the UI having done the right thing.
// ---------------------------------------------------------------------------

let reachable = false;
let world: World;
/** A task in `world.project` assigned to `world.engineer`, sitting at version 1. */
let engineerTaskId = "";
/** A task in `world.project` assigned to `world.otherEngineer`. */
let otherTaskId = "";

beforeAll(async () => {
	reachable = await databaseIsReachable();
	if (!reachable) {
		return;
	}
	world = await buildWorld();
	engineerTaskId = await createTask(
		world.pm,
		world.project.id,
		"Engineer owned task",
		{ assignedToId: world.engineer.userId, department: "BACKEND" },
	);
	otherTaskId = await createTask(
		world.pm,
		world.project.id,
		"Someone else's task",
		{ assignedToId: world.otherEngineer.userId, department: "FRONTEND" },
	);
});

afterAll(cleanupFixtures);

/** Reads the current version so each patch starts from a known good state. */
async function versionOf(taskId: string): Promise<number> {
	const row = await readTaskRow(taskId);
	if (!row) {
		throw new Error(`fixture: task ${taskId} disappeared`);
	}
	return row.version;
}

describe("RBAC and ABAC", () => {
	test("the suite is skipped loudly rather than passing on an empty database", () => {
		assertSuiteIsRunnable(reachable);
	});

	describe("product manager", () => {
		test("can read a project it is a member of", async () => {
			const res = await api(`/projects/${world.project.id}`, {
				token: world.pm.token,
			});
			expect(res.status).toBe(200);
		});

		test("can create a task and assign it to a member", async () => {
			const taskId = await createTask(
				world.pm,
				world.project.id,
				"PM created and assigned",
				{ assignedToId: world.engineer.userId, department: "BACKEND" },
			);
			const row = await readTaskRow(taskId);
			expect(row?.assignedToId).toBe(world.engineer.userId);
		});

		test("can edit a task description", async () => {
			const res = await api(`/tasks/${engineerTaskId}`, {
				method: "PATCH",
				token: world.pm.token,
				body: {
					version: await versionOf(engineerTaskId),
					description: "Revised by the product manager",
				},
			});
			expect(res.status).toBe(200);
			const row = await readTaskRow(engineerTaskId);
			expect(row?.description).toBe("Revised by the product manager");
		});

		test("can define a dependency between two tasks", async () => {
			const prereq = await createTask(world.pm, world.project.id, "PM prereq");
			const dependent = await createTask(
				world.pm,
				world.project.id,
				"PM dependent",
			);
			const res = await addDependency(
				world.pm,
				world.project.id,
				dependent,
				prereq,
			);
			expect(res.status).toBe(201);
		});
	});

	describe("internal team member", () => {
		test("can view a project it belongs to", async () => {
			const res = await api(`/projects/${world.project.id}`, {
				token: world.engineer.token,
			});
			expect(res.status).toBe(200);
		});

		test("cannot reach a project it is not a member of", async () => {
			// `world.pm` owns the foreign project and the foreign client is its
			// only member, so this engineer is genuinely outside.
			const res = await api(`/projects/${world.foreignProject.id}`, {
				token: world.engineer.token,
			});
			expect([403, 404]).toContain(res.status);
			if (res.status === 403) {
				expect(errorCode(res)).toBe("PROJECT_ACCESS_DENIED");
			}
		});

		test("can change the status of a task assigned to it", async () => {
			const taskId = await createTask(
				world.pm,
				world.project.id,
				"Engineer moves own task",
				{ assignedToId: world.engineer.userId, department: "BACKEND" },
			);
			const res = await api(`/tasks/${taskId}`, {
				method: "PATCH",
				token: world.engineer.token,
				body: { version: await versionOf(taskId), status: "IN_PROGRESS" },
			});
			expect(res.status).toBe(200);
		});

		test("cannot edit a task description, even on a task assigned to it", async () => {
			const res = await api(`/tasks/${engineerTaskId}`, {
				method: "PATCH",
				token: world.engineer.token,
				body: {
					version: await versionOf(engineerTaskId),
					description: "Engineer trying to rewrite the brief",
				},
			});
			expect(res.status).toBe(403);
			expect(errorCode(res)).toBe("TASK_ACCESS_DENIED");
			// The rejected write left no trace.
			const row = await readTaskRow(engineerTaskId);
			expect(row?.description).toBe("Revised by the product manager");
		});

		test("cannot change assignment, priority, department or client visibility", async () => {
			const fields: readonly [string, unknown][] = [
				["assignedToId", world.otherEngineer.userId],
				["priority", "URGENT"],
				["department", "PRODUCT"],
				["clientVisible", true],
			];

			for (const [field, value] of fields) {
				const res = await api(`/tasks/${engineerTaskId}`, {
					method: "PATCH",
					token: world.engineer.token,
					body: { version: await versionOf(engineerTaskId), [field]: value },
				});
				expect(res.status).toBe(403);
				expect(errorCode(res)).toBe("TASK_ACCESS_DENIED");
			}
		});

		test("cannot change the status of a task assigned to somebody else", async () => {
			const res = await api(`/tasks/${otherTaskId}`, {
				method: "PATCH",
				token: world.engineer.token,
				body: { version: await versionOf(otherTaskId), status: "IN_PROGRESS" },
			});
			expect(res.status).toBe(403);
			expect(errorCode(res)).toBe("TASK_ACCESS_DENIED");
		});

		test("cannot create a dependency", async () => {
			const a = await createTask(world.pm, world.project.id, "Dep perm a");
			const b = await createTask(world.pm, world.project.id, "Dep perm b");
			const res = await addDependency(world.engineer, world.project.id, a, b);
			expect(res.status).toBe(403);
			expect(errorCode(res)).toBe("DEPENDENCY_ACCESS_DENIED");
		});

		test("cannot read the audit history of a task it cannot see", async () => {
			const res = await api(
				`/projects/${world.foreignProject.id}/tasks/${otherTaskId}/audit-logs`,
				{ token: world.engineer.token },
			);
			expect([403, 404]).toContain(res.status);
		});
	});

	describe("client guest", () => {
		test("is refused the internal project surface outright", async () => {
			const res = await api(`/projects/${world.project.id}`, {
				token: world.client.token,
			});
			expect(res.status).toBe(403);
			expect(errorCode(res)).toBe("PROJECT_ACCESS_DENIED");
		});

		test("is refused the internal task surface outright", async () => {
			const res = await api("/tasks", { token: world.client.token });
			expect(res.status).toBe(403);
			expect(errorCode(res)).toBe("TASK_ACCESS_DENIED");
		});

		test("cannot create a task", async () => {
			const res = await api("/tasks", {
				method: "POST",
				token: world.client.token,
				body: { projectId: world.project.id, title: "Client authored" },
			});
			expect(res.status).toBe(403);
		});

		test("is refused every write on the client surface", async () => {
			for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
				const res = await api("/client/dashboard", {
					method,
					token: world.client.token,
					body: { anything: true },
				});
				expect(res.status).toBe(403);
				expect(errorCode(res)).toBe("CLIENT_READ_ONLY");
			}
		});
	});

	describe("changing an id in the URL grants nothing", () => {
		test("a task id from another project is not readable", async () => {
			const foreignTaskId = await createTask(
				world.pm,
				world.foreignProject.id,
				"Foreign task",
			);
			// The engineer is a member of the primary project only.
			const res = await api(`/tasks/${foreignTaskId}`, {
				token: world.engineer.token,
			});
			expect([403, 404]).toContain(res.status);
		});

		test("a task id from another project is not writable", async () => {
			const foreignTaskId = await createTask(
				world.pm,
				world.foreignProject.id,
				"Foreign task writable",
			);
			const res = await api(`/tasks/${foreignTaskId}`, {
				method: "PATCH",
				token: world.engineer.token,
				body: { version: 1, title: "Hijacked" },
			});
			expect([403, 404]).toContain(res.status);
			const row = await readTaskRow(foreignTaskId);
			expect(row?.title).toBe("Foreign task writable");
		});

		test("attachments and audit of an unreachable task stay unreachable", async () => {
			const foreignTaskId = await createTask(
				world.pm,
				world.foreignProject.id,
				"Foreign task attachments",
			);
			const paths = [
				`/projects/${world.foreignProject.id}/tasks/${foreignTaskId}/attachments`,
				`/projects/${world.foreignProject.id}/tasks/${foreignTaskId}/audit-logs`,
				`/projects/${world.foreignProject.id}/tasks/${foreignTaskId}/dependencies`,
			];

			for (const path of paths) {
				const res = await api(path, { token: world.engineer.token });
				expect([403, 404]).toContain(res.status);
			}
		});

		test("a task id that does not exist is a 404, not a 500", async () => {
			const res = await api("/tasks/00000000-0000-4000-8000-000000000000", {
				token: world.pm.token,
			});
			expect(res.status).toBe(404);
		});

		test("a malformed id is rejected before any lookup", async () => {
			const res = await api("/tasks/not-a-uuid", { token: world.pm.token });
			expect(res.status).toBe(400);
			expect(errorCode(res)).toBe("INVALID_REQUEST");
		});
	});
});
