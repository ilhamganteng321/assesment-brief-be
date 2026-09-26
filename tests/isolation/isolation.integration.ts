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
} from "../helpers/harness";

// ---------------------------------------------------------------------------
// Client guest tenant isolation (assessment section 6).
//
// A client guest belongs to one project and must learn nothing about any
// other. That includes the indirect channels: a status code that differs
// between "does not exist" and "not yours", a pagination total that counts
// rows the caller may not read, a field that was never meant to leave the
// server, and an error message that names a resource it should not reveal.
// ---------------------------------------------------------------------------

let reachable = false;
let world: World;
/** A client-visible task in the client's own project. */
let sharedTaskId = "";
/** An internal-only task in the client's own project. */
let internalTaskId = "";

beforeAll(async () => {
	reachable = await databaseIsReachable();
	if (!reachable) {
		return;
	}
	world = await buildWorld();
	sharedTaskId = await createTask(
		world.pm,
		world.project.id,
		"Shared deliverable",
		{ clientVisible: true, description: "Safe to show a client" },
	);
	internalTaskId = await createTask(
		world.pm,
		world.project.id,
		"Internal only work",
		{ clientVisible: false, description: "Never shown to a client" },
	);
});

afterAll(cleanupFixtures);

/** The exact keys a client is allowed to receive on a task. */
const CLIENT_TASK_KEYS = [
	"clientVisible",
	"description",
	"id",
	"status",
	"title",
];

describe("client guest isolation", () => {
	test("the suite is skipped loudly rather than passing on an empty database", () => {
		assertSuiteIsRunnable(reachable);
	});

	describe("a project the guest does not belong to", () => {
		test("is reported exactly as a project that does not exist", async () => {
			const absent = await api(
				"/client/projects/00000000-0000-4000-8000-000000000000/tasks",
				{ token: world.client.token },
			);
			const foreign = await api(
				`/client/projects/${world.foreignProject.id}/tasks`,
				{ token: world.client.token },
			);

			// Identical status, code and message: the endpoint does not confirm
			// that the project exists.
			expect(foreign.status).toBe(absent.status);
			expect(foreign.status).toBe(404);
			expect(errorCode(foreign)).toBe(errorCode(absent));
			expect(errorCode(foreign)).toBe("PROJECT_NOT_FOUND");
			expect(jsonPath(foreign, ["error", "message"])).toBe(
				jsonPath(absent, ["error", "message"]),
			);
		});

		test("its task list, task detail and metrics are all unreachable", async () => {
			const paths = [
				`/client/projects/${world.foreignProject.id}/tasks`,
				`/client/projects/${world.foreignProject.id}/tasks/${sharedTaskId}`,
			];
			for (const path of paths) {
				const res = await api(path, { token: world.client.token });
				expect(res.status).toBe(404);
			}

			// The internal surfaces a client may not use at all.
			for (const path of [
				`/projects/${world.foreignProject.id}`,
				`/projects/${world.foreignProject.id}/metrics`,
				`/projects/${world.foreignProject.id}/activity`,
			]) {
				const res = await api(path, { token: world.client.token });
				expect(res.status).toBe(403);
			}
		});

		test("another client's own project is equally invisible", async () => {
			const res = await api(`/client/projects/${world.foreignProject.id}/tasks`, {
				token: world.client.token,
			});
			// The foreign client *can* see it, which is what makes this a real
			// tenant boundary rather than an empty project.
			const asOwner = await api(
				`/client/projects/${world.foreignProject.id}/tasks`,
				{ token: world.foreignClient.token },
			);
			expect(asOwner.status).toBe(200);
			expect(res.status).toBe(404);
		});
	});

	describe("within the guest's own project", () => {
		test("a visible task is returned with the approved keys only", async () => {
			const res = await api(
				`/client/projects/${world.project.id}/tasks/${sharedTaskId}`,
				{ token: world.client.token },
			);

			expect(res.status).toBe(200);
			const task = jsonPath<Record<string, unknown>>(res, ["data", "task"]);
			expect(Object.keys(task ?? {}).sort()).toEqual(CLIENT_TASK_KEYS);
		});

		test("an internal-only task is indistinguishable from a missing one", async () => {
			const hidden = await api(
				`/client/projects/${world.project.id}/tasks/${internalTaskId}`,
				{ token: world.client.token },
			);
			// Compared against a task id that never existed in the guest's *own*
			// project, so only the task's visibility differs between the two.
			const absent = await api(
				`/client/projects/${world.project.id}/tasks/00000000-0000-4000-8000-000000000000`,
				{ token: world.client.token },
			);

			expect(hidden.status).toBe(404);
			expect(hidden.status).toBe(absent.status);
			expect(errorCode(hidden)).toBe(errorCode(absent));
			expect(jsonPath(hidden, ["error", "message"])).toBe(
				jsonPath(absent, ["error", "message"]),
			);
		});

		test("the list omits internal tasks and its total counts only what it returns", async () => {
			const res = await api(`/client/projects/${world.project.id}/tasks?limit=100`, {
				token: world.client.token,
			});

			expect(res.status).toBe(200);
			const rows = jsonPath<Record<string, unknown>[]>(res, ["data", "tasks"]);
			expect(Array.isArray(rows)).toBe(true);
			for (const row of rows ?? []) {
				expect(Object.keys(row).sort()).toEqual(CLIENT_TASK_KEYS);
			}
			// The total must describe the visible slice, not the whole project,
			// otherwise the count itself leaks the size of what is hidden.
			expect(jsonPath<number>(res, ["data", "pagination", "total"])).toBe(
				rows?.length ?? 0,
			);
			expect(res.text).not.toContain(internalTaskId);
		});

		test("an internal task's title never appears anywhere in the payload", async () => {
			const res = await api(`/client/projects/${world.project.id}/tasks?limit=100`, {
				token: world.client.token,
			});
			expect(res.text).not.toContain("Internal only work");
			expect(res.text).not.toContain("Never shown to a client");
		});
	});

	describe("the dashboard is scoped and sanitised", () => {
		test("lists only the guest's own project", async () => {
			const res = await api("/client/dashboard", { token: world.client.token });

			expect(res.status).toBe(200);
			expect(res.text).not.toContain(world.foreignProject.name);
			const projects = jsonPath<Record<string, unknown>[]>(res, ["data", "projects"]);
			expect(projects).toHaveLength(1);
			expect(jsonPath<string>(res, ["data", "projects", 0, "id"])).toBe(
				world.project.id,
			);
		});

		test("a project entry carries no internal fields", async () => {
			const res = await api("/client/dashboard", { token: world.client.token });

			const project = jsonPath<Record<string, unknown>>(res, [
				"data",
				"projects",
				0,
			]);
			expect(Object.keys(project ?? {}).sort()).toEqual([
				"id",
				"name",
				"progress",
				"tasks",
			]);
		});

		test("the progress figure counts only client-visible work", async () => {
			const res = await api("/client/dashboard", { token: world.client.token });

			const total = jsonPath<number>(res, ["data", "projects", 0, "tasks", "total"]);
			// The project holds far more tasks than the guest may see.
			const visible = await api(
				`/client/projects/${world.project.id}/tasks?limit=100`,
				{ token: world.client.token },
			);
			const rows = jsonPath<unknown[]>(visible, ["data", "tasks"]);
			expect(total).toBe(rows?.length ?? 0);
			expect(total).toBeGreaterThan(0);
			expect(total).toBeLessThan(100);
		});
	});

	describe("internal surfaces stay closed", () => {
		// The rule the API now states uniformly: everything under `/projects/*`
		// and `/tasks/*` is for the internal team, and a client guest reads
		// through `/client/*` instead. Reaching an internal route used to hand a
		// client the full task projection, which carries the assignee id,
		// department, priority, version and the dependency graph.
		test("the internal task list is refused", async () => {
			for (const path of ["/tasks", `/projects/${world.project.id}/tasks`]) {
				const res = await api(path, { token: world.client.token });
				expect(res.status).toBe(403);
				expect(errorCode(res)).toBe("TASK_ACCESS_DENIED");
			}
		});

		test("an internal task read never returns internal fields", async () => {
			// Even for a client-visible task, which the portal does expose.
			for (const path of [
				`/projects/${world.project.id}/tasks/${sharedTaskId}`,
				`/tasks/${sharedTaskId}`,
			]) {
				const res = await api(path, { token: world.client.token });
				expect(res.status).toBe(403);
				expect(res.text).not.toContain("assignedToId");
				expect(res.text).not.toContain("department");
				expect(res.text).not.toContain("version");
			}
		});

		test("the dependency graph is not exposed on an internal route", async () => {
			for (const path of [
				`/projects/${world.project.id}/tasks/${sharedTaskId}/dependencies`,
				`/tasks/${sharedTaskId}/dependencies`,
			]) {
				const res = await api(path, { token: world.client.token });
				expect(res.status).toBe(403);
			}
		});

		test("metrics, activity and attachments are refused", async () => {
			const paths = [
				`/projects/${world.project.id}/metrics`,
				`/projects/${world.project.id}/activity`,
				`/projects/${world.project.id}/tasks/${sharedTaskId}/attachments`,
				`/projects/${world.project.id}/tasks/${sharedTaskId}/audit-logs`,
				`/projects/${world.project.id}/members`,
			];
			for (const path of paths) {
				const res = await api(path, { token: world.client.token });
				expect(res.status).toBe(403);
			}
		});

		test("a client-visible task is still not editable through the internal API", async () => {
			const res = await api(`/tasks/${sharedTaskId}`, {
				method: "PATCH",
				token: world.client.token,
				body: { version: 1, title: "Rewritten by the client" },
			});
			expect(res.status).toBe(403);
		});
	});
});
