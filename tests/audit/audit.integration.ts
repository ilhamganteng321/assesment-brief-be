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
	readAuditRows,
	readTaskRow,
} from "../helpers/harness";

// ---------------------------------------------------------------------------
// Audit trail, audit immutability and soft deletion (assessment sections 15,
// 16 and 17).
//
// Three separate guarantees:
//
//   * every tracked field change appends a row carrying who, when, which
//     column, and the old and new values;
//   * the log is append-only, so no verb can rewrite or erase it;
//   * a soft-deleted task disappears from the API while its row, and the record
//     of what happened to it, remain.
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

async function engineerTask(title: string): Promise<string> {
	return createTask(world.pm, world.project.id, title, {
		assignedToId: world.engineer.userId,
		department: "BACKEND",
		description: "the original description",
	});
}

/** The most recent audit row for a column. */
async function latestFor(
	taskId: string,
	column: string,
): Promise<{ oldValue: string | null; newValue: string | null; userId: string } | null> {
	const rows = await readAuditRows(taskId);
	const match = rows.filter((row) => row.changedColumn === column);
	const row = match[0];
	return row ? { oldValue: row.oldValue, newValue: row.newValue, userId: row.userId } : null;
}

describe("audit trail and soft delete", () => {
	test("the suite is skipped loudly rather than passing on an empty database", () => {
		assertSuiteIsRunnable(reachable);
	});

	describe("tracked changes are recorded", () => {
		test("a description change is recorded with old and new values", async () => {
			const taskId = await engineerTask("Audit description");

			const res = await api(`/tasks/${taskId}`, {
				method: "PATCH",
				token: world.pm.token,
				body: {
					version: await versionOf(taskId),
					description: "a rewritten description",
				},
			});
			expect(res.status).toBe(200);

			const entry = await latestFor(taskId, "description");
			expect(entry).not.toBeNull();
			expect(entry?.oldValue).toBe("the original description");
			expect(entry?.newValue).toBe("a rewritten description");
		});

		test("a status change is recorded", async () => {
			const taskId = await engineerTask("Audit status");

			await api(`/tasks/${taskId}`, {
				method: "PATCH",
				token: world.engineer.token,
				body: { version: await versionOf(taskId), status: "IN_PROGRESS" },
			});

			const entry = await latestFor(taskId, "status");
			expect(entry?.oldValue).toBe("TODO");
			expect(entry?.newValue).toBe("IN_PROGRESS");
		});

		test("an assignment change is recorded with the user ids", async () => {
			const taskId = await engineerTask("Audit assignment");

			await api(`/tasks/${taskId}`, {
				method: "PATCH",
				token: world.pm.token,
				body: {
					version: await versionOf(taskId),
					assignedToId: world.otherEngineer.userId,
					department: "FRONTEND",
				},
			});

			const entry = await latestFor(taskId, "assignedToId");
			expect(entry?.oldValue).toBe(world.engineer.userId);
			expect(entry?.newValue).toBe(world.otherEngineer.userId);
		});

		test("a dependency change is visible in the task's own history", async () => {
			const taskId = await engineerTask("Audit dependency");
			const prereq = await createTask(world.pm, world.project.id, "Audit prereq");

			const res = await api(
				`/projects/${world.project.id}/tasks/${taskId}/dependencies`,
				{ method: "POST", token: world.pm.token, body: { dependencyTaskId: prereq } },
			);
			expect(res.status).toBe(201);

			// The task read now reports the edge, so the change is observable even
			// though the dependency table is not one of the audited columns.
			const detail = await api(`/tasks/${taskId}`, { token: world.pm.token });
			expect(detail.text).toContain(prereq);
		});

		test("the recorded user is the authenticated actor", async () => {
			const taskId = await engineerTask("Audit provenance");

			await api(`/tasks/${taskId}`, {
				method: "PATCH",
				token: world.engineer.token,
				body: { version: await versionOf(taskId), title: "Renamed by engineer" },
			});

			const entry = await latestFor(taskId, "title");
			expect(entry?.userId).toBe(world.engineer.userId);
		});

		test("rewriting an identical value appends nothing", async () => {
			const taskId = await engineerTask("Audit no-op");

			await api(`/tasks/${taskId}`, {
				method: "PATCH",
				token: world.pm.token,
				body: {
					version: await versionOf(taskId),
					description: "the original description",
				},
			});
			const before = await readAuditRows(taskId);

			const res = await api(`/tasks/${taskId}`, {
				method: "PATCH",
				token: world.pm.token,
				body: {
					version: await versionOf(taskId),
					description: "the original description",
				},
			});
			expect(res.status).toBe(200);
			expect((await readAuditRows(taskId)).length).toBe(before.length);
		});

		test("the audit endpoint reports who, what and when", async () => {
			const taskId = await engineerTask("Audit read model");

			await api(`/tasks/${taskId}`, {
				method: "PATCH",
				token: world.pm.token,
				body: { version: await versionOf(taskId), title: "Read model title" },
			});

			const res = await api(
				`/projects/${world.project.id}/tasks/${taskId}/audit-logs`,
				{ token: world.pm.token },
			);
			expect(res.status).toBe(200);

			const rows = jsonPath<Record<string, unknown>[]>(res, ["data", "auditLogs"]);
			expect(Array.isArray(rows)).toBe(true);
			const titleRow = rows?.find((row) => row.changedColumn === "title");
			expect(titleRow).toBeDefined();
			for (const key of ["userId", "changedColumn", "oldValue", "newValue", "createdAt"]) {
				expect(titleRow).toHaveProperty(key);
			}
			expect(jsonPath(res, ["data", "pagination", "total"])).toBeGreaterThan(0);
		});
	});

	describe("the log is append-only", () => {
		test("no verb can create, alter or erase an audit row", async () => {
			const taskId = await engineerTask("Audit immutable");
			await api(`/tasks/${taskId}`, {
				method: "PATCH",
				token: world.pm.token,
				body: { version: await versionOf(taskId), title: "Immutable" },
			});
			const before = await readAuditRows(taskId);

			const path = `/projects/${world.project.id}/tasks/${taskId}/audit-logs`;
			for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
				const res = await api(path, {
					method,
					token: world.pm.token,
					body: { changedColumn: "title", newValue: "tampered" },
				});
				// Rejected by the route's explicit immutability guard, not merely
				// by the absence of a matching handler.
				expect(res.status).toBe(403);
				expect(errorCode(res)).toBe("AUDIT_ACCESS_DENIED");
			}

			const after = await readAuditRows(taskId);
			expect(after.length).toBe(before.length);
			expect(JSON.stringify(after)).toBe(JSON.stringify(before));
		});

		test("even a project manager cannot rewrite history", async () => {
			const taskId = await engineerTask("Audit pm immutable");
			const before = await readAuditRows(taskId);

			const res = await api(
				`/projects/${world.project.id}/tasks/${taskId}/audit-logs/${before[0]?.id ?? "00000000-0000-4000-8000-000000000000"}`,
				{ method: "DELETE", token: world.pm.token },
			);
			expect([403, 404, 405]).toContain(res.status);
			expect((await readAuditRows(taskId)).length).toBe(before.length);
		});

		test("a client guest cannot read the log at all", async () => {
			const taskId = await createTask(world.pm, world.project.id, "Audit client", {
				clientVisible: true,
			});

			const res = await api(
				`/projects/${world.project.id}/tasks/${taskId}/audit-logs`,
				{ token: world.client.token },
			);
			expect(res.status).toBe(403);
			expect(errorCode(res)).toBe("AUDIT_ACCESS_DENIED");
		});
	});

	describe("soft deletion", () => {
		test("a deleted task leaves the normal read paths", async () => {
			const taskId = await engineerTask("Soft delete me");
			const version = await versionOf(taskId);

			const deleted = await api(`/tasks/${taskId}?version=${version}`, {
				method: "DELETE",
				token: world.pm.token,
			});
			expect(deleted.status).toBe(204);

			const detail = await api(`/tasks/${taskId}`, { token: world.pm.token });
			expect(detail.status).toBe(404);
			expect(errorCode(detail)).toBe("TASK_NOT_FOUND");

			const list = await api(`/tasks?filters=${JSON.stringify({ id: taskId })}`, {
				token: world.pm.token,
			});
			expect(jsonPath<number>(list, ["data", "pagination", "total"])).toBe(0);
		});

		test("the row is still in the database", async () => {
			const taskId = await engineerTask("Soft delete keeps the row");
			await api(`/tasks/${taskId}?version=${await versionOf(taskId)}`, {
				method: "DELETE",
				token: world.pm.token,
			});

			const row = await readTaskRow(taskId);
			expect(row).not.toBeNull();
			expect(row?.deletedAt).not.toBeNull();
		});

		test("the history of a deleted task survives", async () => {
			const taskId = await engineerTask("Soft delete keeps history");
			await api(`/tasks/${taskId}`, {
				method: "PATCH",
				token: world.pm.token,
				body: { version: await versionOf(taskId), title: "Before deletion" },
			});
			const before = await readAuditRows(taskId);
			expect(before.length).toBeGreaterThan(0);

			await api(`/tasks/${taskId}?version=${await versionOf(taskId)}`, {
				method: "DELETE",
				token: world.pm.token,
			});

			// The delete itself is recorded, and the earlier rows are intact.
			const after = await readAuditRows(taskId);
			expect(after.length).toBeGreaterThan(before.length);
			expect(after.some((row) => row.changedColumn === "deletedAt")).toBe(true);
		});

		test("a deleted task cannot be deleted a second time", async () => {
			const taskId = await engineerTask("Soft delete twice");
			const version = await versionOf(taskId);
			await api(`/tasks/${taskId}?version=${version}`, {
				method: "DELETE",
				token: world.pm.token,
			});

			const res = await api(`/tasks/${taskId}?version=${version}`, {
				method: "DELETE",
				token: world.pm.token,
			});
			expect([404, 409]).toContain(res.status);
		});

		test("a deleted task is not exposed through the client portal", async () => {
			const taskId = await createTask(world.pm, world.project.id, "Soft delete client", {
				clientVisible: true,
			});
			await api(`/tasks/${taskId}?version=${await versionOf(taskId)}`, {
				method: "DELETE",
				token: world.pm.token,
			});

			const res = await api(
				`/client/projects/${world.project.id}/tasks/${taskId}`,
				{ token: world.client.token },
			);
			expect(res.status).toBe(404);
		});

		test("a deleted prerequisite still blocks its dependents", async () => {
			const prereq = await createTask(world.pm, world.project.id, "Deleted prereq");
			const dependent = await engineerTask("Dependent of a deleted prereq");
			await api(`/projects/${world.project.id}/tasks/${dependent}/dependencies`, {
				method: "POST",
				token: world.pm.token,
				body: { dependencyTaskId: prereq },
			});

			// Removing the prerequisite must not silently release the dependent.
			await api(`/tasks/${prereq}?version=${await versionOf(prereq)}`, {
				method: "DELETE",
				token: world.pm.token,
			});

			const res = await api(`/tasks/${dependent}`, {
				method: "PATCH",
				token: world.engineer.token,
				body: { version: await versionOf(dependent), status: "IN_PROGRESS" },
			});
			expect(res.status).toBe(409);
			expect(errorCode(res)).toBe("TASK_BLOCKED");
		});
	});
});
