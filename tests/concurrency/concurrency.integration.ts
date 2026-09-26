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
// Optimistic locking (assessment sections 13 and 14).
//
// Every mutation must name the version it read. Two callers that read the same
// version cannot both win: the loser is told 409 and its change is discarded
// rather than merged silently.
//
// The important half of each check is the database read afterwards. A handler
// that returned 409 but had already written would pass a status-code test and
// still lose data, so every assertion here pairs the response with the stored
// row.
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

/** A task owned by the engineer, created fresh for each scenario. */
async function freshTask(title: string): Promise<{ id: string; version: number }> {
	const id = await createTask(world.pm, world.project.id, title, {
		assignedToId: world.engineer.userId,
		department: "BACKEND",
		description: "original description",
	});
	return { id, version: await versionOf(id) };
}

async function versionOf(taskId: string): Promise<number> {
	const row = await readTaskRow(taskId);
	if (!row) {
		throw new Error(`fixture: task ${taskId} disappeared`);
	}
	return row.version;
}

describe("optimistic locking", () => {
	test("the suite is skipped loudly rather than passing on an empty database", () => {
		assertSuiteIsRunnable(reachable);
	});

	test("a new task starts at version 1", async () => {
		const { id, version } = await freshTask("Version starts at one");

		expect(version).toBe(1);
		const res = await api(`/tasks/${id}`, { token: world.pm.token });
		expect(jsonPath<number>(res, ["data", "task", "version"])).toBe(1);
	});

	test("a successful update advances the version by exactly one", async () => {
		const { id, version } = await freshTask("Version advances once");

		const res = await api(`/tasks/${id}`, {
			method: "PATCH",
			token: world.pm.token,
			body: { version, description: "second description" },
		});

		expect(res.status).toBe(200);
		expect(jsonPath<number>(res, ["data", "task", "version"])).toBe(version + 1);
		expect((await readTaskRow(id))?.version).toBe(version + 1);
	});

	describe("two readers, one version", () => {
		test("the second writer is rejected with 409 and its change is discarded", async () => {
			const { id, version } = await freshTask("Two readers");

			// Both callers read the same version.
			const readerA = version;
			const readerB = version;
			expect(readerA).toBe(readerB);

			const first = await api(`/tasks/${id}`, {
				method: "PATCH",
				token: world.pm.token,
				body: { version: readerA, description: "written by A" },
			});
			expect(first.status).toBe(200);

			const second = await api(`/tasks/${id}`, {
				method: "PATCH",
				token: world.pm.token,
				body: { version: readerB, description: "written by B" },
			});

			expect(second.status).toBe(409);
			expect(errorCode(second)).toBe("CONCURRENT_MODIFICATION");
			// B's write did not land, so A's value is intact rather than one of
			// the two silently overwriting the other.
			expect((await readTaskRow(id))?.description).toBe("written by A");
		});

		test("the conflict names the expected and current versions", async () => {
			const { id, version } = await freshTask("Conflict reports versions");

			await api(`/tasks/${id}`, {
				method: "PATCH",
				token: world.pm.token,
				body: { version, description: "A wins" },
			});
			const loser = await api(`/tasks/${id}`, {
				method: "PATCH",
				token: world.pm.token,
				body: { version, description: "B loses" },
			});

			expect(loser.status).toBe(409);
		expect(jsonPath<number>(loser, ["error", "expectedVersion"])).toBe(version);
		expect(jsonPath<number>(loser, ["error", "currentVersion"])).toBe(version + 1);
		});

		test("the conflict carries the current state so the client can reconcile", async () => {
			const { id, version } = await freshTask("Conflict carries state");

			await api(`/tasks/${id}`, {
				method: "PATCH",
				token: world.pm.token,
				body: { version, title: "Renamed by A" },
			});
			const loser = await api(`/tasks/${id}`, {
				method: "PATCH",
				token: world.pm.token,
				body: { version, title: "Renamed by B" },
			});

			expect(loser.status).toBe(409);
		expect(jsonPath<string>(loser, ["error", "latestTask", "title"])).toBe(
			"Renamed by A",
		);
		expect(jsonPath<number>(loser, ["error", "latestTask", "version"])).toBe(
			version + 1,
		);
		});
	});

	describe("different fields, same version", () => {
		test("a description change and a status change cannot both be applied", async () => {
			const { id, version } = await freshTask("Field level race");

			// The PM edits the description...
			const descriptionWrite = await api(`/tasks/${id}`, {
				method: "PATCH",
				token: world.pm.token,
				body: { version, description: "PM description" },
			});
			expect(descriptionWrite.status).toBe(200);

			// ...while the engineer, holding the same original version, tries to
			// start the task.
			const statusWrite = await api(`/tasks/${id}`, {
				method: "PATCH",
				token: world.engineer.token,
				body: { version, status: "IN_PROGRESS" },
			});

			expect(statusWrite.status).toBe(409);
			expect(errorCode(statusWrite)).toBe("CONCURRENT_MODIFICATION");
			const row = await readTaskRow(id);
			// Exactly one update survived, and it is a whole-row write, so the
			// loser's field is simply not present rather than merged.
			expect(row?.description).toBe("PM description");
			expect(row?.status).toBe("TODO");
		});

		test("retrying with the fresh version succeeds", async () => {
			const { id, version } = await freshTask("Retry after conflict");

			await api(`/tasks/${id}`, {
				method: "PATCH",
				token: world.pm.token,
				body: { version, description: "A" },
			});
			const rejected = await api(`/tasks/${id}`, {
				method: "PATCH",
				token: world.pm.token,
				body: { version, description: "B" },
			});
			expect(rejected.status).toBe(409);

			// The client refetches and resubmits against the current version.
			const retried = await api(`/tasks/${id}`, {
				method: "PATCH",
				token: world.pm.token,
				body: { version: version + 1, description: "B" },
			});

			expect(retried.status).toBe(200);
			expect((await readTaskRow(id))?.description).toBe("B");
		});
	});

	describe("the version is not a writable field", () => {
		test("the stored version always advances by one, whatever was submitted", async () => {
			const { id, version } = await freshTask("Version is server owned");

			const res = await api(`/tasks/${id}`, {
				method: "PATCH",
				token: world.pm.token,
				body: { version, description: "a" },
			});
			expect(res.status).toBe(200);

			// Submitting a large version is accepted by the schema but matches
			// nothing, so it is a conflict rather than a way to skip ahead.
			const ahead = await api(`/tasks/${id}`, {
				method: "PATCH",
				token: world.pm.token,
				body: { version: 999_999, description: "b" },
			});
			expect(ahead.status).toBe(409);
			expect((await readTaskRow(id))?.version).toBe(version + 1);
		});

		test("a missing or malformed version is a validation error", async () => {
			const { id, version } = await freshTask("Version is mandatory");

			for (const body of [
				{ description: "no version" },
				{ version: 0, description: "zero" },
				{ version: -1, description: "negative" },
				{ version: 1.5, description: "fractional" },
				{ version: "1", description: "string" },
				{ version: null, description: "null" },
			]) {
				const res = await api(`/tasks/${id}`, {
					method: "PATCH",
					token: world.pm.token,
					body,
				});
				expect(res.status).toBe(400);
				expect(errorCode(res)).toBe("INVALID_REQUEST");
			}

			// None of the rejected attempts moved the task.
			expect((await readTaskRow(id))?.version).toBe(version);
		});
	});

	describe("deletes take part in the same scheme", () => {
		test("a delete at a stale version is rejected", async () => {
			const { id, version } = await freshTask("Delete loses the race");

			await api(`/tasks/${id}`, {
				method: "PATCH",
				token: world.pm.token,
				body: { version, description: "A moved it on" },
			});
			const stale = await api(`/tasks/${id}?version=${version}`, {
				method: "DELETE",
				token: world.pm.token,
			});

			expect(stale.status).toBe(409);
			expect(errorCode(stale)).toBe("CONCURRENT_MODIFICATION");
			// Still present, because the losing delete did not soft-delete it.
			expect((await readTaskRow(id))?.deletedAt).toBeNull();
		});

		test("a delete at the current version succeeds", async () => {
			const { id, version } = await freshTask("Delete wins the race");

			const res = await api(`/tasks/${id}?version=${version}`, {
				method: "DELETE",
				token: world.pm.token,
			});

			expect(res.status).toBe(204);
			expect((await readTaskRow(id))?.deletedAt).not.toBeNull();
		});

		test("a patch cannot revive a task that was deleted", async () => {
			const { id, version } = await freshTask("Delete then patch");

			expect(
				(
					await api(`/tasks/${id}?version=${version}`, {
						method: "DELETE",
						token: world.pm.token,
					})
				).status,
			).toBe(204);

			const res = await api(`/tasks/${id}`, {
				method: "PATCH",
				token: world.pm.token,
				body: { version: version + 1, description: "back from the dead" },
			});

			expect([404, 409]).toContain(res.status);
		});
	});

	describe("a rejected write leaves no audit trail", () => {
		test("the losing writer records nothing", async () => {
			const { id, version } = await freshTask("No audit for a loser");

			await api(`/tasks/${id}`, {
				method: "PATCH",
				token: world.pm.token,
				body: { version, description: "A" },
			});
			const before = await readAuditRows(id);
			const rejected = await api(`/tasks/${id}`, {
				method: "PATCH",
				token: world.pm.token,
				body: { version, description: "B" },
			});
			expect(rejected.status).toBe(409);

			const after = await readAuditRows(id);
			// The audit rows live in the same transaction as the mutation, so a
			// conflict cannot leave a record of a change that never happened.
			expect(after.length).toBe(before.length);
		});
	});
});
