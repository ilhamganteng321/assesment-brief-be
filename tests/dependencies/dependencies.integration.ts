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
} from "../helpers/harness";

// ---------------------------------------------------------------------------
// Dependency integrity (assessment sections 10, 11 and 12).
//
// The graph has to stay resolvable: no task may depend on itself, no edge may
// close a loop, and a repeated edge must be reported rather than stored twice.
// Every refusal is asserted with its status and code, because "it did not
// create the edge" alone would also be satisfied by a request that silently
// did nothing.
// ---------------------------------------------------------------------------

let reachable = false;
let world: World;
/** Three tasks in `world.project` used to build chains and loops. */
let a = "";
let b = "";
let c = "";

beforeAll(async () => {
	reachable = await databaseIsReachable();
	if (!reachable) {
		return;
	}
	world = await buildWorld();
	a = await createTask(world.pm, world.project.id, "Chain A");
	b = await createTask(world.pm, world.project.id, "Chain B");
	c = await createTask(world.pm, world.project.id, "Chain C");
});

afterAll(cleanupFixtures);

const dependOn = (dependent: string, dependency: string) =>
	addDependency(world.pm, world.project.id, dependent, dependency);

describe("dependency integrity", () => {
	test("the suite is skipped loudly rather than passing on an empty database", () => {
		assertSuiteIsRunnable(reachable);
	});

	test("a straightforward dependency is created", async () => {
		const res = await dependOn(b, a);
		expect(res.status).toBe(201);
	});

	describe("self dependency", () => {
		test("is rejected", async () => {
			const res = await dependOn(c, c);

			expect(res.status).toBe(400);
			expect(errorCode(res)).toBe("SELF_DEPENDENCY");
		});

		test("leaves no edge behind", async () => {
			const list = await api(`/tasks/${c}/dependencies`, { token: world.pm.token });
			expect(list.status).toBe(200);
			expect(jsonPath<unknown[]>(list, ["data", "dependencies"])).toHaveLength(0);
		});
	});

	describe("duplicate dependency", () => {
		test("a repeated edge is reported instead of stored twice", async () => {
			expect((await dependOn(b, a)).status).toBe(409);

			const list = await api(`/tasks/${b}/dependencies`, { token: world.pm.token });
			expect(list.status).toBe(200);
			// b -> a was created once, so exactly one edge exists.
			const dependencies = jsonPath<unknown[]>(list, ["data", "dependencies"]);
			expect(Array.isArray(dependencies)).toBe(true);
			expect(dependencies).toHaveLength(1);
			expect(jsonPath<string>(list, ["data", "dependencies", 0, "id"])).toBe(a);
		});

		test("the refusal carries a conflict code", async () => {
			const res = await dependOn(b, a);
			expect(res.status).toBe(409);
			expect(errorCode(res)).toBe("DEPENDENCY_ALREADY_EXISTS");
		});
	});

	describe("circular dependency", () => {
		test("closing a two-task loop is rejected", async () => {
			// b already depends on a, so a -> b would close the cycle.
			const res = await dependOn(a, b);

			expect(res.status).toBe(409);
			expect(errorCode(res)).toBe("CIRCULAR_DEPENDENCY");
		});

		test("closing a three-task loop is rejected", async () => {
			// Chain so far: b -> a. Add c -> b, then a -> c would close a loop.
			expect((await dependOn(c, b)).status).toBe(201);

			const res = await dependOn(a, c);

			expect(res.status).toBe(409);
			expect(errorCode(res)).toBe("CIRCULAR_DEPENDENCY");
		});

		test("a diamond is not a cycle", async () => {
			// Two tasks sharing a prerequisite is a fan-out, not a loop.
			const left = await createTask(world.pm, world.project.id, "Diamond left");
			const right = await createTask(world.pm, world.project.id, "Diamond right");
			const root = await createTask(world.pm, world.project.id, "Diamond root");

			expect((await dependOn(left, root)).status).toBe(201);
			expect((await dependOn(right, root)).status).toBe(201);
		});

		test("a longer chain is accepted and a longer loop is still rejected", async () => {
			const chain = await Promise.all(
				["L1", "L2", "L3", "L4", "L5"].map((name) =>
					createTask(world.pm, world.project.id, `Chain ${name}`),
				),
			);
			const [l1, l2, l3, l4, l5] = chain as [string, string, string, string, string];

			// l5 -> l4 -> l3 -> l2 -> l1
			for (const [dependent, dependency] of [
				[l5, l4],
				[l4, l3],
				[l3, l2],
				[l2, l1],
			] as const) {
				expect((await dependOn(dependent, dependency)).status).toBe(201);
			}

			// l1 -> l5 would close a five-node loop.
			const res = await dependOn(l1, l5);
			expect(res.status).toBe(409);
			expect(errorCode(res)).toBe("CIRCULAR_DEPENDENCY");
		});
	});

	describe("boundary and ownership", () => {
		test("a dependency across two projects is rejected", async () => {
			const foreignTask = await createTask(
				world.pm,
				world.foreignProject.id,
				"Foreign prereq",
			);

			const res = await dependOn(a, foreignTask);

			expect(res.status).toBe(400);
			expect(errorCode(res)).toBe("CROSS_PROJECT_DEPENDENCY");
		});

		test("a dependency on a task that does not exist is a 404", async () => {
			const res = await dependOn(
				a,
				"00000000-0000-4000-8000-000000000000",
			);

			expect(res.status).toBe(404);
			expect(errorCode(res)).toBe("TASK_NOT_FOUND");
		});

		test("a malformed dependency id is rejected before any lookup", async () => {
			const res = await dependOn(a, "not-a-uuid");

			expect(res.status).toBe(400);
		});

		test("removing a dependency that was never created is a 404", async () => {
			const standalone = await createTask(
				world.pm,
				world.project.id,
				"Standalone",
			);
			const res = await api(
				`/projects/${world.project.id}/tasks/${standalone}/dependencies/${a}`,
				{ method: "DELETE", token: world.pm.token },
			);

			expect(res.status).toBe(404);
			expect(errorCode(res)).toBe("DEPENDENCY_NOT_FOUND");
		});

		test("an engineer cannot remove a dependency", async () => {
			const res = await api(
				`/projects/${world.project.id}/tasks/${b}/dependencies/${a}`,
				{ method: "DELETE", token: world.engineer.token },
			);

			expect(res.status).toBe(403);
			expect(errorCode(res)).toBe("DEPENDENCY_ACCESS_DENIED");
		});

		test("a client guest cannot read the dependency graph", async () => {
			const res = await api(`/tasks/${b}/dependencies`, {
				token: world.client.token,
			});

			expect([403, 404]).toContain(res.status);
		});
	});
});
