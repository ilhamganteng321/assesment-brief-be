import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import { db } from "../../src/prisma/db";
import {
	type Actor,
	api,
	assertSuiteIsRunnable,
	buildWorld,
	cleanupFixtures,
	createTask,
	databaseIsReachable,
	errorCode,
	jsonPath,
	type World,
} from "../helpers/harness";

// ---------------------------------------------------------------------------
// The project lifecycle, exercised through the HTTP surface.
//
// Every assertion goes through the deployed routes, so a lifecycle rule can only
// pass if the running service enforces it. "Cannot do it" is asserted as a
// refusal *and* as proof that the stored row is unchanged, because a 409 that
// still wrote to the database would pass a status-code-only test.
//
// A project walks forward one step at a time:
//
//     PLANNING -> ACTIVE -> COMPLETED -> ARCHIVED
//
// and ARCHIVED is terminal. There is no reopen, so reopening is asserted to be
// impossible rather than merely absent from the interface.
// ---------------------------------------------------------------------------

let reachable = false;
let world: World;

/**
 * The projects this suite creates.
 *
 * Held here rather than in the shared harness because the harness only tracks
 * the projects it made itself. A lifecycle test needs a project in a specific
 * status, and each one is created fresh so no test depends on another's state —
 * which means each one has to be removed afterwards, or the next run of any suite
 * sees a database with more projects in it than the last.
 */
const lifecycleProjectIds: string[] = [];

beforeAll(async () => {
	reachable = await databaseIsReachable();
	if (!reachable) {
		return;
	}
	world = await buildWorld();
});

afterAll(async () => {
	// Child rows first, then the projects themselves, then the shared fixtures.
	// A project that still has tasks cannot be removed by the cascade alone
	// because the suite may have left an archived one behind.
	for (const projectId of lifecycleProjectIds) {
		try {
			await db.orm.public.Tasks.where((t) =>
				t.projectId.eq(projectId),
			).delete();
			await db.orm.public.ProjectMembers.where((m) =>
				m.projectId.eq(projectId),
			).delete();
			await db.orm.public.Projects.where((p) => p.id.eq(projectId)).delete();
		} catch {
			// best-effort: the shared cleanup below reports anything it cannot do
		}
	}
	lifecycleProjectIds.length = 0;
	await cleanupFixtures();
});

async function lifecycleProject(
	name: string,
	status?: "PLANNING" | "ACTIVE" | "COMPLETED" | "ARCHIVED",
): Promise<string> {
	const created = await api("/projects", {
		method: "POST",
		token: world.pm.token,
		body: {
			name: `${name} ${Date.now().toString(36)}`,
			clientName: "Lifecycle Client",
			...(status === undefined ? {} : { status }),
		},
	});
	const id = jsonPath<string>(created, ["data", "project", "id"]) ?? "";
	if (id.length === 0) {
		throw new Error(
			`fixture: project creation failed (status=${created.status}, body=${created.text.slice(0, 200)})`,
		);
	}
	lifecycleProjectIds.push(id);
	return id;
}

async function setStatus(
	actor: Actor,
	projectId: string,
	status: string,
): Promise<{ status: number; code: string }> {
	const res = await api(`/projects/${projectId}/status`, {
		method: "PATCH",
		token: actor.token,
		body: { status },
	});
	return { status: res.status, code: errorCode(res) };
}

/** Reads the stored row, to prove what was actually persisted. */
async function readProjectRow(projectId: string): Promise<{
	status: string;
	name: string;
	clientName: string | null;
	deletedAt: unknown;
} | null> {
	const row = await db.orm.public.Projects.first({ id: projectId });
	if (!row) {
		return null;
	}
	return {
		status: String(row.status),
		name: String(row.name),
		clientName: row.clientName === null ? null : String(row.clientName),
		deletedAt: row.deletedAt,
	};
}

describe("project lifecycle", () => {
	test("the suite is skipped loudly rather than passing on an empty database", () => {
		assertSuiteIsRunnable(reachable);
	});

	describe("permitted transitions", () => {
		test("a PM can move ACTIVE to COMPLETED", async () => {
			const projectId = await lifecycleProject("It completes", "ACTIVE");

			const outcome = await setStatus(world.pm, projectId, "COMPLETED");

			expect(outcome.status).toBe(200);
			expect((await readProjectRow(projectId))?.status).toBe("COMPLETED");
		});

		test("a PM can move COMPLETED to ARCHIVED", async () => {
			const projectId = await lifecycleProject("It archives", "COMPLETED");

			const outcome = await setStatus(world.pm, projectId, "ARCHIVED");

			expect(outcome.status).toBe(200);
			expect((await readProjectRow(projectId))?.status).toBe("ARCHIVED");
		});

		test("a PM can walk a project the whole way to ARCHIVED", async () => {
			const projectId = await lifecycleProject("It full walk", "PLANNING");

			expect((await setStatus(world.pm, projectId, "ACTIVE")).status).toBe(200);
			expect((await setStatus(world.pm, projectId, "COMPLETED")).status).toBe(
				200,
			);
			expect((await setStatus(world.pm, projectId, "ARCHIVED")).status).toBe(
				200,
			);

			expect((await readProjectRow(projectId))?.status).toBe("ARCHIVED");
		});

		// The status route returns the project it produced, so the interface can
		// replace its cached row without a second request.
		test("the status route returns the updated project", async () => {
			const projectId = await lifecycleProject("It status payload", "ACTIVE");

			const res = await api(`/projects/${projectId}/status`, {
				method: "PATCH",
				token: world.pm.token,
				body: { status: "COMPLETED" },
			});

			expect(res.status).toBe(200);
			expect(jsonPath<string>(res, ["data", "project", "id"])).toBe(projectId);
			expect(jsonPath<string>(res, ["data", "project", "status"])).toBe(
				"COMPLETED",
			);
		});
	});

	describe("refused transitions", () => {
		test("ACTIVE cannot skip straight to ARCHIVED", async () => {
			const projectId = await lifecycleProject("It skip", "ACTIVE");

			const outcome = await setStatus(world.pm, projectId, "ARCHIVED");

			expect(outcome.status).toBe(409);
			expect(outcome.code).toBe("INVALID_PROJECT_STATUS_TRANSITION");
			expect((await readProjectRow(projectId))?.status).toBe("ACTIVE");
		});

		test("PLANNING cannot skip straight to ARCHIVED either", async () => {
			const projectId = await lifecycleProject("It planning skip", "PLANNING");

			const outcome = await setStatus(world.pm, projectId, "ARCHIVED");

			expect(outcome.status).toBe(409);
			expect(outcome.code).toBe("INVALID_PROJECT_STATUS_TRANSITION");
			expect((await readProjectRow(projectId))?.status).toBe("PLANNING");
		});

		test("a project cannot be moved back to ACTIVE", async () => {
			const projectId = await lifecycleProject("It rewind", "COMPLETED");

			const outcome = await setStatus(world.pm, projectId, "ACTIVE");

			expect(outcome.status).toBe(409);
			expect(outcome.code).toBe("INVALID_PROJECT_STATUS_TRANSITION");
			expect((await readProjectRow(projectId))?.status).toBe("COMPLETED");
		});

		test("an archived project cannot be reactivated", async () => {
			const projectId = await lifecycleProject("It unarchive", "ARCHIVED");

			const outcome = await setStatus(world.pm, projectId, "ACTIVE");

			expect(outcome.status).toBe(409);
			expect(outcome.code).toBe("INVALID_PROJECT_STATUS_TRANSITION");
			expect((await readProjectRow(projectId))?.status).toBe("ARCHIVED");
		});

		test("an archived project cannot be moved back to COMPLETED", async () => {
			const projectId = await lifecycleProject("It unarchive two", "ARCHIVED");

			const outcome = await setStatus(world.pm, projectId, "COMPLETED");

			expect(outcome.status).toBe(409);
			expect(outcome.code).toBe("INVALID_PROJECT_STATUS_TRANSITION");
			expect((await readProjectRow(projectId))?.status).toBe("ARCHIVED");
		});

		test("the conflict names both ends of the refused move", async () => {
			const projectId = await lifecycleProject("It conflict shape", "ACTIVE");

			const res = await api(`/projects/${projectId}/status`, {
				method: "PATCH",
				token: world.pm.token,
				body: { status: "ARCHIVED" },
			});

			expect(res.status).toBe(409);
			expect(jsonPath<boolean>(res, ["success"])).toBe(false);
			expect(jsonPath<string>(res, ["error", "message"])).toBe(
				"Project cannot transition from ACTIVE to ARCHIVED.",
			);
			expect(jsonPath<string>(res, ["error", "fromStatus"])).toBe("ACTIVE");
			expect(jsonPath<string>(res, ["error", "toStatus"])).toBe("ARCHIVED");
		});

		// The general update route accepts a status, so the rule has to hold there
		// too. Otherwise the dedicated endpoint would be a formality.
		test("the general update route enforces the same rule", async () => {
			const projectId = await lifecycleProject("It patch skip", "ACTIVE");

			const res = await api(`/projects/${projectId}`, {
				method: "PATCH",
				token: world.pm.token,
				body: { status: "ARCHIVED" },
			});

			expect(res.status).toBe(409);
			expect(errorCode(res)).toBe("INVALID_PROJECT_STATUS_TRANSITION");
			expect((await readProjectRow(projectId))?.status).toBe("ACTIVE");
		});

		test("an unknown status is a validation failure, not a lifecycle error", async () => {
			const projectId = await lifecycleProject("It unknown status", "ACTIVE");

			const outcome = await setStatus(world.pm, projectId, "REOPENED");

			expect(outcome.status).toBe(400);
			expect((await readProjectRow(projectId))?.status).toBe("ACTIVE");
		});

		// A retry whose response was lost must not fail with a conflict the caller
		// can do nothing about.
		test("re-asserting the current status succeeds", async () => {
			const projectId = await lifecycleProject("It idempotent", "ACTIVE");

			const outcome = await setStatus(world.pm, projectId, "ACTIVE");

			expect(outcome.status).toBe(200);
			expect((await readProjectRow(projectId))?.status).toBe("ACTIVE");
		});
	});

	describe("authorization", () => {
		test("a client guest cannot change project status", async () => {
			const projectId = await lifecycleProject("It client status", "ACTIVE");
			await api(`/projects/${projectId}/members`, {
				method: "POST",
				token: world.pm.token,
				body: { userId: world.client.userId },
			});

			const outcome = await setStatus(world.client, projectId, "COMPLETED");

			expect(outcome.status).toBe(403);
			expect((await readProjectRow(projectId))?.status).toBe("ACTIVE");
		});

		test("a client guest cannot edit project metadata either", async () => {
			const projectId = await lifecycleProject("It client edit", "ACTIVE");
			await api(`/projects/${projectId}/members`, {
				method: "POST",
				token: world.pm.token,
				body: { userId: world.client.userId },
			});

			const res = await api(`/projects/${projectId}`, {
				method: "PATCH",
				token: world.client.token,
				body: { name: "Client rename" },
			});

			expect(res.status).toBe(403);
			expect((await readProjectRow(projectId))?.name).not.toBe("Client rename");
		});

		// The lifecycle grants no role a permission it did not already have.
		test("an internal member cannot change project status", async () => {
			const projectId = await lifecycleProject("It internal status", "ACTIVE");
			await api(`/projects/${projectId}/members`, {
				method: "POST",
				token: world.pm.token,
				body: { userId: world.engineer.userId },
			});

			const outcome = await setStatus(world.engineer, projectId, "COMPLETED");

			expect(outcome.status).toBe(403);
			expect((await readProjectRow(projectId))?.status).toBe("ACTIVE");
		});

		test("an internal user who is not a member cannot touch another project", async () => {
			// The engineer is a member of `world.project` and not of this one.
			const projectId = await lifecycleProject("It foreign status", "ACTIVE");

			const status = await setStatus(world.engineer, projectId, "COMPLETED");
			const edit = await api(`/projects/${projectId}`, {
				method: "PATCH",
				token: world.engineer.token,
				body: { name: "Not mine" },
			});

			expect(status.status).toBe(403);
			expect(edit.status).toBe(403);
			expect((await readProjectRow(projectId))?.status).toBe("ACTIVE");
			expect((await readProjectRow(projectId))?.name).not.toBe("Not mine");
		});

		test("a client guest from another project cannot reach this one", async () => {
			const projectId = await lifecycleProject("It tenant status", "ACTIVE");
			// `world.client` is a member here; `world.foreignClient` is not.
			await api(`/projects/${projectId}/members`, {
				method: "POST",
				token: world.pm.token,
				body: { userId: world.client.userId },
			});

			const outcome = await setStatus(
				world.foreignClient,
				projectId,
				"COMPLETED",
			);

			expect(outcome.status).toBe(403);
			expect((await readProjectRow(projectId))?.status).toBe("ACTIVE");
		});

		test("an unauthenticated status change is rejected", async () => {
			const projectId = await lifecycleProject("It anon status", "ACTIVE");

			const res = await api(`/projects/${projectId}/status`, {
				method: "PATCH",
				body: { status: "COMPLETED" },
			});

			expect(res.status).toBe(401);
			expect((await readProjectRow(projectId))?.status).toBe("ACTIVE");
		});
	});

	describe("soft delete protection", () => {
		test("a deleted project cannot change status", async () => {
			const projectId = await lifecycleProject("It deleted status", "ACTIVE");
			expect(
				(
					await api(`/projects/${projectId}`, {
						method: "DELETE",
						token: world.pm.token,
					})
				).status,
			).toBe(204);

			const outcome = await setStatus(world.pm, projectId, "COMPLETED");

			expect(outcome.status).toBe(404);
			expect(outcome.code).toBe("PROJECT_NOT_FOUND");
		});

		test("a deleted project cannot be edited", async () => {
			const projectId = await lifecycleProject("It deleted edit", "ACTIVE");
			await api(`/projects/${projectId}`, {
				method: "DELETE",
				token: world.pm.token,
			});

			const res = await api(`/projects/${projectId}`, {
				method: "PATCH",
				token: world.pm.token,
				body: { name: "Resurrected" },
			});

			expect(res.status).toBe(404);
		});

		test("a deleted project is excluded from the list and from detail", async () => {
			const projectId = await lifecycleProject("It deleted hidden", "ACTIVE");
			await api(`/projects/${projectId}`, {
				method: "DELETE",
				token: world.pm.token,
			});

			const listed = await api("/projects?rows=100", { token: world.pm.token });
			const detail = await api(`/projects/${projectId}`, {
				token: world.pm.token,
			});

			const ids = jsonPath<Array<{ id: string }>>(listed, ["data", "projects"]);
			expect((ids ?? []).some((row) => row.id === projectId)).toBe(false);
			expect(detail.status).toBe(404);
		});
	});

	describe("archived projects are read-only", () => {
		test("metadata cannot be edited once a project is archived", async () => {
			const projectId = await lifecycleProject("It archived edit", "ARCHIVED");

			const res = await api(`/projects/${projectId}`, {
				method: "PATCH",
				token: world.pm.token,
				body: { name: "Renamed after archiving" },
			});

			expect(res.status).toBe(409);
			expect(errorCode(res)).toBe("PROJECT_ARCHIVED");
			expect((await readProjectRow(projectId))?.status).toBe("ARCHIVED");
		});

		// Archiving must be a lifecycle move, not a euphemism for deletion: the
		// record, its client name and its history all survive.
		test("archiving preserves the project record", async () => {
			const projectId = await lifecycleProject("It archived keeps", "ACTIVE");
			await api(`/projects/${projectId}/status`, {
				method: "PATCH",
				token: world.pm.token,
				body: { status: "COMPLETED" },
			});
			await api(`/projects/${projectId}/status`, {
				method: "PATCH",
				token: world.pm.token,
				body: { status: "ARCHIVED" },
			});

			const row = await readProjectRow(projectId);
			const detail = await api(`/projects/${projectId}`, {
				token: world.pm.token,
			});

			expect(row?.status).toBe("ARCHIVED");
			expect(row?.deletedAt).toBeNull();
			expect(row?.clientName).toBe("Lifecycle Client");
			expect(detail.status).toBe(200);
		});
	});

	describe("metadata validation and mass assignment", () => {
		test("a blank name is rejected", async () => {
			const projectId = await lifecycleProject("It blank name", "ACTIVE");

			const res = await api(`/projects/${projectId}`, {
				method: "PATCH",
				token: world.pm.token,
				body: { name: "   " },
			});

			expect(res.status).toBe(400);
			expect((await readProjectRow(projectId))?.name).not.toBe("");
		});

		test("an oversized name is rejected", async () => {
			const projectId = await lifecycleProject("It long name", "ACTIVE");

			const res = await api(`/projects/${projectId}`, {
				method: "PATCH",
				token: world.pm.token,
				body: { name: "x".repeat(151) },
			});

			expect(res.status).toBe(400);
		});

		test("a name is trimmed before it is stored", async () => {
			const projectId = await lifecycleProject("It trim name", "ACTIVE");

			await api(`/projects/${projectId}`, {
				method: "PATCH",
				token: world.pm.token,
				body: { name: "  Trimmed Name  " },
			});

			expect((await readProjectRow(projectId))?.name).toBe("Trimmed Name");
		});

		test("an empty client name clears the column rather than storing a blank", async () => {
			const projectId = await lifecycleProject("It clear client", "ACTIVE");

			await api(`/projects/${projectId}`, {
				method: "PATCH",
				token: world.pm.token,
				body: { clientName: "   " },
			});

			expect((await readProjectRow(projectId))?.clientName).toBeNull();
		});

		// The request schema is a strict object, so a column the product does not
		// expose is refused outright rather than quietly dropped.
		test("a field outside the allow-list is refused", async () => {
			const projectId = await lifecycleProject("It mass assign", "ACTIVE");

			const res = await api(`/projects/${projectId}`, {
				method: "PATCH",
				token: world.pm.token,
				body: { name: "Still fine", deletedAt: null, id: projectId },
			});

			expect(res.status).toBe(400);
			expect((await readProjectRow(projectId))?.deletedAt).toBeNull();
		});

		test("a relationship field cannot be written through the update route", async () => {
			const projectId = await lifecycleProject("It mass members", "ACTIVE");

			const res = await api(`/projects/${projectId}`, {
				method: "PATCH",
				token: world.pm.token,
				body: { name: "Still fine", members: [] },
			});

			expect(res.status).toBe(400);
		});

		test("the status route refuses to carry metadata alongside the status", async () => {
			const projectId = await lifecycleProject("It status extra", "ACTIVE");

			const res = await api(`/projects/${projectId}/status`, {
				method: "PATCH",
				token: world.pm.token,
				body: { status: "COMPLETED", name: "Sneaky rename" },
			});

			expect(res.status).toBe(400);
			expect((await readProjectRow(projectId))?.status).toBe("ACTIVE");
			expect((await readProjectRow(projectId))?.name).not.toBe("Sneaky rename");
		});
	});

	describe("completing a project", () => {
		// Completion is a decision about the project, not about its tasks. The
		// server records the move the caller asked for and changes nothing else.
		test("completing a project leaves unfinished tasks exactly as they were", async () => {
			const projectId = await lifecycleProject("It completes early", "ACTIVE");
			const taskId = await createTaskFixture(world.pm, projectId);

			const outcome = await setStatus(world.pm, projectId, "COMPLETED");

			expect(outcome.status).toBe(200);
			const task = await db.orm.public.Tasks.first({ id: taskId });
			expect(task?.status).toBe("TODO");
			expect(task?.deletedAt).toBeNull();
			expect((await readProjectRow(projectId))?.status).toBe("COMPLETED");
		});

		test("a project with no tasks at all can still be completed", async () => {
			const projectId = await lifecycleProject("It completes empty", "ACTIVE");

			const outcome = await setStatus(world.pm, projectId, "COMPLETED");

			expect(outcome.status).toBe(200);
		});
	});

	describe("the project list", () => {
		test("every row carries the server-computed progress percentage", async () => {
			const listed = await api("/projects?rows=100", { token: world.pm.token });

			expect(listed.status).toBe(200);
			const rows = jsonPath<
				Array<{ id: string; progress: { percentage: number } }>
			>(listed, ["data", "projects"]);
			expect((rows ?? []).length).toBeGreaterThan(0);
			for (const row of rows ?? []) {
				expect(typeof row.progress?.percentage).toBe("number");
			}
		});

		test("the list progress matches the project's own metrics", async () => {
			const projectId = await lifecycleProject("It progress agrees", "ACTIVE");
			await createTaskFixture(world.pm, projectId, "DONE");
			await createTaskFixture(world.pm, projectId, "TODO");

			const listed = await api(
				`/projects?rows=100&filters=${encodeURIComponent(
					JSON.stringify({ id: projectId }),
				)}`,
				{ token: world.pm.token },
			);
			const metrics = await api(`/projects/${projectId}/metrics`, {
				token: world.pm.token,
			});

			const row = jsonPath<Array<{ progress: { percentage: number } }>>(
				listed,
				["data", "projects"],
			)?.[0];
			expect(row?.progress.percentage).toBe(
				jsonPath<number>(metrics, [
					"data",
					"metrics",
					"progress",
					"percentage",
				]),
			);
		});
	});
});

/** Creates a task inside a lifecycle fixture project. */
async function createTaskFixture(
	actor: Actor,
	projectId: string,
	status: "TODO" | "DONE" = "TODO",
): Promise<string> {
	return createTask(
		actor,
		projectId,
		`Lifecycle task ${Date.now().toString(36)}`,
		{
			status,
		},
	);
}
