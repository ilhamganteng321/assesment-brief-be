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
	jsonPath,
	readTaskRow,
} from "../helpers/harness";

// ---------------------------------------------------------------------------
// State based permissions and dependency gating (assessment sections 7, 8, 9).
//
// The transition rules are not a lookup table in the code; they fall out of two
// independent gates, and this suite pins the resulting matrix from the outside:
//   * a role gate, which CLIENT never passes;
//   * an ownership gate, which limits an engineer to its own assignments;
//   * a dependency gate, which refuses to start a task whose prerequisites are
//     unfinished.
//
// "Cannot do it" is asserted as a refusal *and* as proof that the stored row is
// untouched, because a 403 that still wrote to the database would pass a
// status-code-only test.
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

/** Creates a task owned by the engineer, at the requested starting status. */
async function engineerTask(
	title: string,
	status: "TODO" | "BLOCKED" | "IN_PROGRESS" = "TODO",
): Promise<string> {
	return createTask(world.pm, world.project.id, title, {
		assignedToId: world.engineer.userId,
		department: "BACKEND",
		status,
	});
}

async function patchStatus(
	actor: { token: string },
	taskId: string,
	status: string,
): Promise<{ status: number; code: string }> {
	const res = await api(`/tasks/${taskId}`, {
		method: "PATCH",
		token: actor.token,
		body: { version: await versionOf(taskId), status },
	});
	return { status: res.status, code: errorCode(res) };
}

describe("state based permissions", () => {
	test("the suite is skipped loudly rather than passing on an empty database", () => {
		assertSuiteIsRunnable(reachable);
	});

	describe("allowed transitions", () => {
		test("an engineer can move its own task TODO to IN_PROGRESS", async () => {
			const taskId = await engineerTask("Transition todo to in progress");

			const outcome = await patchStatus(world.engineer, taskId, "IN_PROGRESS");

			expect(outcome.status).toBe(200);
			expect((await readTaskRow(taskId))?.status).toBe("IN_PROGRESS");
		});

		test("an engineer can complete its own task IN_PROGRESS to DONE", async () => {
			const taskId = await engineerTask(
				"Transition in progress to done",
				"IN_PROGRESS",
			);

			const outcome = await patchStatus(world.engineer, taskId, "DONE");

			expect(outcome.status).toBe(200);
			expect((await readTaskRow(taskId))?.status).toBe("DONE");
		});

		test("a PM can move a task to BLOCKED to record a manual hold", async () => {
			const taskId = await engineerTask("Transition to blocked");

			const outcome = await patchStatus(world.pm, taskId, "BLOCKED");

			expect(outcome.status).toBe(200);
			expect((await readTaskRow(taskId))?.status).toBe("BLOCKED");
		});
	});

	describe("the PM completion rule", () => {
		test("a PM cannot complete a task that is in progress for somebody else", async () => {
			const taskId = await createTask(world.pm, world.project.id, "PM cannot close", {
				assignedToId: world.engineer.userId,
				department: "BACKEND",
				status: "IN_PROGRESS",
			});

			const outcome = await patchStatus(world.pm, taskId, "DONE");

			expect(outcome.status).toBe(403);
			expect(outcome.code).toBe("TASK_ACCESS_DENIED");
			// The refusal must not have advanced the task or its version.
			const row = await readTaskRow(taskId);
			expect(row?.status).toBe("IN_PROGRESS");
			expect(row?.version).toBe(await versionOf(taskId));
		});

		test("a PM can complete its own in-progress task", async () => {
			const taskId = await createTask(world.pm, world.project.id, "PM closes own", {
				assignedToId: world.pm.userId,
				department: "PRODUCT",
				status: "IN_PROGRESS",
			});

			const outcome = await patchStatus(world.pm, taskId, "DONE");

			expect(outcome.status).toBe(200);
			expect((await readTaskRow(taskId))?.status).toBe("DONE");
		});
	});

	describe("refused transitions", () => {
		test("a client guest cannot change any status", async () => {
			// A client can never be an assignee, so the shared task is an
			// ordinary internal one that the guest is not even entitled to see.
			const taskId = await engineerTask("Client cannot move");

			const outcome = await patchStatus(world.client, taskId, "IN_PROGRESS");

			expect(outcome.status).toBe(403);
			expect((await readTaskRow(taskId))?.status).toBe("TODO");
		});

		test("an engineer cannot move a colleague's task", async () => {
			const taskId = await createTask(
				world.pm,
				world.project.id,
				"Not mine",
				{ assignedToId: world.otherEngineer.userId, department: "FRONTEND" },
			);

			const outcome = await patchStatus(world.engineer, taskId, "IN_PROGRESS");

			expect(outcome.status).toBe(403);
			expect((await readTaskRow(taskId))?.status).toBe("TODO");
		});

		test("an unassigned task cannot be started by an engineer", async () => {
			const taskId = await createTask(
				world.pm,
				world.project.id,
				"Unassigned",
			);

			const outcome = await patchStatus(world.engineer, taskId, "IN_PROGRESS");

			expect(outcome.status).toBe(403);
			expect((await readTaskRow(taskId))?.status).toBe("TODO");
		});
	});

	describe("a single dependency", () => {
		test("a task with an unfinished prerequisite reports itself blocked", async () => {
			const prereq = await createTask(
				world.pm,
				world.project.id,
				"Single prereq",
				{ status: "TODO" },
			);
			const dependent = await engineerTask("Single dependent");
			expect((await addDependency(world.pm, world.project.id, dependent, prereq)).status).toBe(201);

			const res = await api(`/tasks/${dependent}`, { token: world.engineer.token });

			expect(res.status).toBe(200);
			// The stored status is untouched: blocking is derived from the graph,
			// so it is reported on the payload rather than written to the column.
			expect((await readTaskRow(dependent))?.status).toBe("TODO");
			expect(jsonPath<boolean>(res, ["data", "task", "isBlocked"])).toBe(true);
			expect(res.text).toContain(prereq);
		});

		test("starting the dependent task while the prerequisite is open is refused", async () => {
			const prereq = await createTask(world.pm, world.project.id, "Open prereq");
			const dependent = await engineerTask("Gated dependent");
			await addDependency(world.pm, world.project.id, dependent, prereq);

			const outcome = await patchStatus(world.engineer, dependent, "IN_PROGRESS");

			// The existing contract answers this with a conflict, and the body
			// names what is holding the task.
			expect(outcome.status).toBe(409);
			expect(outcome.code).toBe("TASK_BLOCKED");
			expect((await readTaskRow(dependent))?.status).toBe("TODO");
		});

		test("a matching version cannot be used to slip past the dependency rule", async () => {
			const prereq = await createTask(world.pm, world.project.id, "Locked prereq");
			const dependent = await engineerTask("Locked dependent");
			await addDependency(world.pm, world.project.id, dependent, prereq);

			const res = await api(`/tasks/${dependent}`, {
				method: "PATCH",
				token: world.engineer.token,
				body: { version: await versionOf(dependent), status: "IN_PROGRESS" },
			});

			expect(res.status).toBe(409);
			expect(errorCode(res)).toBe("TASK_BLOCKED");
		});

		test("once the prerequisite is done the dependent task can start", async () => {
			const prereq = await createTask(
				world.pm,
				world.project.id,
				"Closed prereq",
				{
					assignedToId: world.pm.userId,
					department: "PRODUCT",
					status: "IN_PROGRESS",
				},
			);
			const dependent = await engineerTask("Unblocked dependent");
			await addDependency(world.pm, world.project.id, dependent, prereq);

			// Blocked to begin with.
			expect((await patchStatus(world.engineer, dependent, "IN_PROGRESS")).status).toBe(409);

			// Complete the prerequisite through the API, as a reviewer would.
			const closeRes = await api(`/tasks/${prereq}`, {
				method: "PATCH",
				token: world.pm.token,
				body: { version: await versionOf(prereq), status: "DONE" },
			});
			expect(closeRes.status).toBe(200);
			expect((await readTaskRow(prereq))?.status).toBe("DONE");

			// Now the dependent task is free to start.
			const outcome = await patchStatus(world.engineer, dependent, "IN_PROGRESS");

			expect(outcome.status).toBe(200);
			expect((await readTaskRow(dependent))?.status).toBe("IN_PROGRESS");
		});
	});

	describe("multiple dependencies", () => {
		test("the dependent task stays blocked until every prerequisite is done", async () => {
			const a = await createTask(world.pm, world.project.id, "Diamond A", {
				assignedToId: world.pm.userId,
				department: "PRODUCT",
				status: "IN_PROGRESS",
			});
			const b = await createTask(world.pm, world.project.id, "Diamond B", {
				assignedToId: world.pm.userId,
				department: "PRODUCT",
			});
			const c = await engineerTask("Diamond C");
			expect((await addDependency(world.pm, world.project.id, c, a)).status).toBe(201);
			expect((await addDependency(world.pm, world.project.id, c, b)).status).toBe(201);

			// Both prerequisites are unfinished.
			let outcome = await patchStatus(world.engineer, c, "IN_PROGRESS");
			expect(outcome.status).toBe(409);
			expect(outcome.code).toBe("TASK_BLOCKED");

			// Finish A only. B is still open, so C must remain blocked.
			expect(
				(
					await api(`/tasks/${a}`, {
						method: "PATCH",
						token: world.pm.token,
						body: { version: await versionOf(a), status: "DONE" },
					})
				).status,
			).toBe(200);
			expect((await readTaskRow(a))?.status).toBe("DONE");

			outcome = await patchStatus(world.engineer, c, "IN_PROGRESS");
			expect(outcome.status).toBe(409);
			expect(outcome.code).toBe("TASK_BLOCKED");
			expect((await readTaskRow(c))?.status).toBe("TODO");

			// Finish B. Now C is free to start.
			expect(
				(
					await api(`/tasks/${b}`, {
						method: "PATCH",
						token: world.pm.token,
						body: { version: await versionOf(b), status: "DONE" },
					})
				).status,
			).toBe(200);

			outcome = await patchStatus(world.engineer, c, "IN_PROGRESS");
			expect(outcome.status).toBe(200);
			expect((await readTaskRow(c))?.status).toBe("IN_PROGRESS");
		});

		test("the refusal names every open prerequisite", async () => {
			const a = await createTask(world.pm, world.project.id, "Named A");
			const b = await createTask(world.pm, world.project.id, "Named B");
			const c = await engineerTask("Named C");
			await addDependency(world.pm, world.project.id, c, a);
			await addDependency(world.pm, world.project.id, c, b);

			const res = await api(`/tasks/${c}`, {
				method: "PATCH",
				token: world.engineer.token,
				body: { version: await versionOf(c), status: "IN_PROGRESS" },
			});

			expect(res.status).toBe(409);
			const body = res.text;
			expect(body).toContain(a);
			expect(body).toContain(b);
		});
	});
});
