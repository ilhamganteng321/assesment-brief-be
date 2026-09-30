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
	readTaskRow,
	TEST_RUN_ID,
	type World,
} from "../helpers/harness";

// ---------------------------------------------------------------------------
// Project membership, exercised through the HTTP surface.
//
// Membership is the thing that *grants* access: an internal engineer can only
// open a project they are a member of, and a client guest can only reach their
// own. So this suite does not only assert what the member endpoints return —
// half of it asserts what becomes reachable afterwards, because a member list
// that renders correctly while access never actually changes would be a feature
// that does not work.
//
// "Cannot do it" is asserted as a refusal *and* as proof that nothing changed,
// since a 403 that still wrote to the database would pass a status-code-only
// test.
// ---------------------------------------------------------------------------

let reachable = false;
let world: World;

/** Accounts this suite provisions for the add/remove cases. */
const ownedUserIds: string[] = [];
/** Projects this suite provisions, cleaned up after the shared fixtures. */
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
	// Child rows first, then the projects, then the extra accounts. A membership
	// this suite created has to go before its project, or the cascade would do it
	// for us and the suite would be relying on that rather than on its own
	// cleanup.
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
			await db.orm.public.Tasks.where((t) =>
				t.projectId.eq(projectId),
			).delete();
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

async function ownedUser(input: {
	name: string;
	email: string;
	role: "PM" | "INTERNAL" | "CLIENT";
	department: "PRODUCT" | "UI_UX" | "FRONTEND" | "BACKEND" | "CLIENT";
}): Promise<Actor> {
	const actor = await provisionUser(input);
	ownedUserIds.push(actor.userId);
	return actor;
}

async function provisionUser(input: {
	name: string;
	email: string;
	role: "PM" | "INTERNAL" | "CLIENT";
	department: "PRODUCT" | "UI_UX" | "FRONTEND" | "BACKEND" | "CLIENT";
}): Promise<Actor> {
	// Reuses the harness so the password hash, the row shape and the login are
	// identical to every other suite's actors.
	const { createPrivilegedActor, itEmail } = await import("../helpers/harness");
	const actor = await createPrivilegedActor({
		role: input.role,
		email: input.email,
		department: input.department === "CLIENT" ? "PRODUCT" : input.department,
	});
	void itEmail;
	return actor;
}

/** A project owned by the PM, with the given members already on it. */
async function ownedProject(
	name: string,
	actor: { token: string } = world.pm,
): Promise<string> {
	const res = await api("/projects", {
		method: "POST",
		token: actor.token,
		body: { name: `${name} ${Date.now().toString(36)}`, status: "ACTIVE" },
	});
	const id = jsonPath<string>(res, ["data", "project", "id"]) ?? "";
	if (id.length === 0) {
		throw new Error(
			`fixture: project creation failed (status=${res.status}, body=${res.text.slice(0, 200)})`,
		);
	}
	ownedProjectIds.push(id);
	return id;
}

async function trackMembership(
	projectId: string,
	userId: string,
): Promise<void> {
	const row = await db.orm.public.ProjectMembers.where(
		(m) => m.projectId.eq(projectId) && m.userId.eq(userId),
	).first();
	if (row !== null) {
		ownedMembershipIds.push(row.id);
	}
}

type MemberRow = {
	userId: string;
	user: {
		id: string;
		name: string;
		email: string;
		role: string;
		department: string;
	};
};

async function listMembers(
	actor: { token: string },
	projectId: string,
): Promise<{ status: number; members: MemberRow[]; text: string }> {
	const res = await api(`/projects/${projectId}/members`, {
		token: actor.token,
	});
	return {
		status: res.status,
		members: jsonPath<MemberRow[]>(res, ["data", "members"]) ?? [],
		text: res.text,
	};
}

async function addMemberRaw(
	actor: { token: string },
	projectId: string,
	userId: string,
): Promise<{ status: number; code: string }> {
	const res = await api(`/projects/${projectId}/members`, {
		method: "POST",
		token: actor.token,
		body: { userId },
	});
	await trackMembership(projectId, userId);
	return { status: res.status, code: errorCode(res) };
}

async function removeMemberRaw(
	actor: { token: string },
	projectId: string,
	userId: string,
): Promise<{
	status: number;
	code: string;
	activeTaskCount?: number;
}> {
	const res = await api(`/projects/${projectId}/members/${userId}`, {
		method: "DELETE",
		token: actor.token,
	});
	return {
		status: res.status,
		code: errorCode(res),
		activeTaskCount: jsonPath<number>(res, ["error", "activeTaskCount"]),
	};
}

async function isMember(projectId: string, userId: string): Promise<boolean> {
	return (
		(await db.orm.public.ProjectMembers.where(
			(m) => m.projectId.eq(projectId) && m.userId.eq(userId),
		).first()) !== null
	);
}

describe("project members", () => {
	test("the suite is skipped loudly rather than passing on an empty database", () => {
		assertSuiteIsRunnable(reachable);
	});

	describe("reading the member list", () => {
		test("a PM can list the members of a project", async () => {
			const result = await listMembers(world.pm, world.project.id);

			expect(result.status).toBe(200);
			// The shared world enrols the PM, the engineer, the other engineer and
			// the client, so a correct list has all four.
			expect(result.members.length).toBeGreaterThanOrEqual(4);
		});

		test("each member carries the fields the interface renders", async () => {
			const result = await listMembers(world.pm, world.project.id);

			for (const member of result.members) {
				expect(typeof member.user.id).toBe("string");
				expect(member.user.name.length).toBeGreaterThan(0);
				expect(member.user.email).toContain("@");
				expect(["PM", "INTERNAL", "CLIENT"]).toContain(member.user.role);
				expect(member.user.department.length).toBeGreaterThan(0);
			}
		});

		// The single most important assertion in this suite: the credential hash
		// must not be readable through a member list, in any form.
		test("the member list never exposes passwordHash or any security field", async () => {
			const result = await listMembers(world.pm, world.project.id);

			expect(result.text).not.toContain("passwordHash");
			expect(result.text).not.toContain("password_hash");
			for (const member of result.members) {
				expect(Object.keys(member.user).sort()).toEqual([
					"department",
					"email",
					"id",
					"name",
					"role",
				]);
			}
		});

		// Membership is the grant, so an internal member must be able to read the
		// list of the project they are on.
		test("an internal member can read their own project's members", async () => {
			const result = await listMembers(world.engineer, world.project.id);

			expect(result.status).toBe(200);
			expect(
				result.members.some(
					(member) => member.userId === world.engineer.userId,
				),
			).toBe(true);
		});

		test("an internal user who is not a member cannot read the list", async () => {
			// The engineer is a member of `world.project` and of nothing else.
			const result = await listMembers(world.engineer, world.foreignProject.id);

			expect(result.status).toBe(403);
			expect(result.text).not.toContain("@example.local");
		});

		test("a non-existent project is a 404", async () => {
			const res = await api(
				"/projects/3c9a1e8a-6d5b-4f21-9c3f-8f0d1a2b3c4d/members",
				{
					token: world.pm.token,
				},
			);

			expect(res.status).toBe(404);
			expect(errorCode(res)).toBe("PROJECT_NOT_FOUND");
		});

		test("an unauthenticated request is rejected", async () => {
			const res = await api(`/projects/${world.project.id}/members`);

			expect(res.status).toBe(401);
		});
	});

	describe("client isolation", () => {
		// The existing client policy exposes no member identities at all: a client
		// reads the scoped /client payloads, which carry no people. These assert
		// that the member surface stays internal, rather than adding a masked
		// client view of identities the product has never shown a client.
		test("a client cannot list a project's members even as a member of it", async () => {
			const res = await api(`/projects/${world.project.id}/members`, {
				token: world.client.token,
			});

			expect(res.status).toBe(403);
			expect(res.text).not.toContain("@example.local");
		});

		test("a client cannot search for users through any project", async () => {
			for (const projectId of [world.project.id, world.foreignProject.id]) {
				const res = await api(
					`/projects/${projectId}/members/candidates?search=it`,
					{ token: world.client.token },
				);
				expect(res.status).toBe(403);
				expect(res.text).not.toContain("@example.local");
			}
		});

		test("a client cannot use another tenant's project id to reach members", async () => {
			const res = await api(
				`/projects/${world.foreignProject.id}/members?search=it`,
				{ token: world.client.token },
			);

			expect(res.status).toBe(403);
		});

		test("a client cannot add or remove a member", async () => {
			const add = await addMemberRaw(
				world.client,
				world.project.id,
				world.engineer.userId,
			);
			const remove = await removeMemberRaw(
				world.client,
				world.project.id,
				world.engineer.userId,
			);

			expect(add.status).toBe(403);
			expect(remove.status).toBe(403);
			expect(await isMember(world.project.id, world.engineer.userId)).toBe(
				true,
			);
		});
	});

	describe("adding a member", () => {
		test("a PM can add an internal user", async () => {
			const projectId = await ownedProject("It adds internal");
			const newcomer = await ownedUser({
				name: "It Newcomer",
				email: `newcomer-${Date.now().toString(36)}@example.local`,
				role: "INTERNAL",
				department: "BACKEND",
			});

			const outcome = await addMemberRaw(world.pm, projectId, newcomer.userId);

			expect(outcome.status).toBe(201);
			expect(await isMember(projectId, newcomer.userId)).toBe(true);
		});

		// Client membership is how a client reaches their own project at all, so
		// the add path has to keep allowing it.
		test("a PM can add a client account, which is the client association", async () => {
			const projectId = await ownedProject("It adds client");
			const guest = await ownedUser({
				name: "It Guest",
				email: `guest-${Date.now().toString(36)}@example.local`,
				role: "CLIENT",
				department: "CLIENT",
			});

			const outcome = await addMemberRaw(world.pm, projectId, guest.userId);

			expect(outcome.status).toBe(201);
			expect(await isMember(projectId, guest.userId)).toBe(true);
		});

		// Membership is the grant. Adding an internal user must actually open the
		// project to them, not merely add a row nobody reads.
		test("the added internal user can then reach the project", async () => {
			const projectId = await ownedProject("It grants access");
			const newcomer = await ownedUser({
				name: "It Granted",
				email: `granted-${Date.now().toString(36)}@example.local`,
				role: "INTERNAL",
				department: "FRONTEND",
			});

			// Before: not a member, so the project is invisible to them.
			const before = await api(`/projects/${projectId}`, {
				token: newcomer.token,
			});
			expect(before.status).toBe(403);

			expect(
				(await addMemberRaw(world.pm, projectId, newcomer.userId)).status,
			).toBe(201);

			const after = await api(`/projects/${projectId}`, {
				token: newcomer.token,
			});
			const listed = await api("/projects", { token: newcomer.token });
			const tasks = await api(`/projects/${projectId}/tasks`, {
				token: newcomer.token,
			});

			expect(after.status).toBe(200);
			expect(jsonPath<string>(after, ["data", "project", "id"])).toBe(
				projectId,
			);
			expect(
				(
					jsonPath<Array<{ id: string }>>(listed, ["data", "projects"]) ?? []
				).some((row) => row.id === projectId),
			).toBe(true);
			expect(tasks.status).toBe(200);
		});

		// And the reverse: removing the membership takes the access away again.
		test("removing the member takes that access away again", async () => {
			const projectId = await ownedProject("It revokes access");
			const newcomer = await ownedUser({
				name: "It Revoked",
				email: `revoked-${Date.now().toString(36)}@example.local`,
				role: "INTERNAL",
				department: "BACKEND",
			});
			await addMemberRaw(world.pm, projectId, newcomer.userId);
			expect(
				(await api(`/projects/${projectId}`, { token: newcomer.token })).status,
			).toBe(200);

			const removed = await removeMemberRaw(
				world.pm,
				projectId,
				newcomer.userId,
			);

			expect(removed.status).toBe(204);
			expect(await isMember(projectId, newcomer.userId)).toBe(false);
			expect(
				(await api(`/projects/${projectId}`, { token: newcomer.token })).status,
			).toBe(403);
		});

		test("an internal user cannot add a member", async () => {
			const projectId = await ownedProject("It internal cannot add");
			const newcomer = await ownedUser({
				name: "It Unwanted",
				email: `unwanted-${Date.now().toString(36)}@example.local`,
				role: "INTERNAL",
				department: "BACKEND",
			});

			const outcome = await addMemberRaw(
				world.engineer,
				projectId,
				newcomer.userId,
			);

			expect(outcome.status).toBe(403);
			expect(await isMember(projectId, newcomer.userId)).toBe(false);
		});

		// A non-member PM-side route is the cross-project case: the engineer is not
		// on this project, so they cannot even see it, let alone change it.
		test("a non-member cannot manipulate another project's membership", async () => {
			const projectId = await ownedProject("It cross project");
			const newcomer = await ownedUser({
				name: "It Outsider",
				email: `outsider-${Date.now().toString(36)}@example.local`,
				role: "INTERNAL",
				department: "BACKEND",
			});

			const added = await addMemberRaw(
				world.otherEngineer,
				projectId,
				newcomer.userId,
			);
			const removed = await removeMemberRaw(
				world.otherEngineer,
				projectId,
				world.pm.userId,
			);

			expect(added.status).toBe(403);
			expect(removed.status).toBe(403);
			expect(await isMember(projectId, newcomer.userId)).toBe(false);
		});

		test("a non-existent user is a 404 USER_NOT_FOUND", async () => {
			const projectId = await ownedProject("It missing user");

			const outcome = await addMemberRaw(
				world.pm,
				projectId,
				"3c9a1e8a-6d5b-4f21-9c3f-8f0d1a2b3c4d",
			);

			expect(outcome.status).toBe(404);
			expect(outcome.code).toBe("USER_NOT_FOUND");
		});

		test("a non-existent project is a 404 PROJECT_NOT_FOUND", async () => {
			const outcome = await addMemberRaw(
				world.pm,
				"3c9a1e8a-6d5b-4f21-9c3f-8f0d1a2b3c4d",
				world.engineer.userId,
			);

			expect(outcome.status).toBe(404);
			expect(outcome.code).toBe("PROJECT_NOT_FOUND");
		});

		test("a malformed userId is a validation failure, not a lookup", async () => {
			const projectId = await ownedProject("It malformed user");

			const res = await api(`/projects/${projectId}/members`, {
				method: "POST",
				token: world.pm.token,
				body: { userId: "not-a-uuid" },
			});

			expect(res.status).toBe(400);
		});

		test("a missing userId is rejected", async () => {
			const projectId = await ownedProject("It absent user");

			const res = await api(`/projects/${projectId}/members`, {
				method: "POST",
				token: world.pm.token,
				body: {},
			});

			expect(res.status).toBe(400);
		});

		test("an archived project refuses new members", async () => {
			const projectId = await ownedProject("It archived roster");
			const newcomer = await ownedUser({
				name: "It Too Late",
				email: `toolate-${Date.now().toString(36)}@example.local`,
				role: "INTERNAL",
				department: "BACKEND",
			});
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

			const outcome = await addMemberRaw(world.pm, projectId, newcomer.userId);

			expect(outcome.status).toBe(409);
			expect(outcome.code).toBe("PROJECT_ARCHIVED");
			expect(await isMember(projectId, newcomer.userId)).toBe(false);
		});

		test("a soft-deleted project refuses new members", async () => {
			const projectId = await ownedProject("It deleted roster");
			const newcomer = await ownedUser({
				name: "It Deleted",
				email: `deleted-${Date.now().toString(36)}@example.local`,
				role: "INTERNAL",
				department: "BACKEND",
			});
			await api(`/projects/${projectId}`, {
				method: "DELETE",
				token: world.pm.token,
			});

			const outcome = await addMemberRaw(world.pm, projectId, newcomer.userId);

			expect(outcome.status).toBe(404);
			expect(await isMember(projectId, newcomer.userId)).toBe(false);
		});
	});

	describe("duplicate membership", () => {
		test("adding the same user twice is a 409", async () => {
			const projectId = await ownedProject("It duplicate");
			const newcomer = await ownedUser({
				name: "It Twice",
				email: `twice-${Date.now().toString(36)}@example.local`,
				role: "INTERNAL",
				department: "BACKEND",
			});

			expect(
				(await addMemberRaw(world.pm, projectId, newcomer.userId)).status,
			).toBe(201);
			const second = await addMemberRaw(world.pm, projectId, newcomer.userId);

			expect(second.status).toBe(409);
			expect(second.code).toBe("PROJECT_MEMBER_ALREADY_EXISTS");
		});

		// The raw constraint message must never reach the caller: it names tables
		// and columns, which is both noise and a small amount of schema.
		test("a duplicate is a clean conflict, not a leaked database error", async () => {
			const projectId = await ownedProject("It duplicate clean");
			const newcomer = await ownedUser({
				name: "It Clean",
				email: `clean-${Date.now().toString(36)}@example.local`,
				role: "INTERNAL",
				department: "BACKEND",
			});
			await addMemberRaw(world.pm, projectId, newcomer.userId);

			const res = await api(`/projects/${projectId}/members`, {
				method: "POST",
				token: world.pm.token,
				body: { userId: newcomer.userId },
			});

			expect(res.status).toBe(409);
			expect(res.text).not.toMatch(/constraint|duplicate key|SQLSTATE/i);
			expect(res.text).not.toContain("project_members");
		});

		test("the same user may be a member of two different projects", async () => {
			const first = await ownedProject("It shared one");
			const second = await ownedProject("It shared two");
			const newcomer = await ownedUser({
				name: "It Shared",
				email: `shared-${Date.now().toString(36)}@example.local`,
				role: "INTERNAL",
				department: "BACKEND",
			});

			expect(
				(await addMemberRaw(world.pm, first, newcomer.userId)).status,
			).toBe(201);
			expect(
				(await addMemberRaw(world.pm, second, newcomer.userId)).status,
			).toBe(201);
		});
	});

	describe("removing a member", () => {
		test("a PM can remove a member", async () => {
			const projectId = await ownedProject("It removes");
			const newcomer = await ownedUser({
				name: "It Removable",
				email: `removable-${Date.now().toString(36)}@example.local`,
				role: "INTERNAL",
				department: "BACKEND",
			});
			await addMemberRaw(world.pm, projectId, newcomer.userId);

			const removed = await removeMemberRaw(
				world.pm,
				projectId,
				newcomer.userId,
			);

			expect(removed.status).toBe(204);
			expect(await isMember(projectId, newcomer.userId)).toBe(false);
		});

		// Removal is of the relationship, never of the person.
		test("removing a member does not delete the user", async () => {
			const projectId = await ownedProject("It keeps user");
			const newcomer = await ownedUser({
				name: "It Survives",
				email: `survives-${Date.now().toString(36)}@example.local`,
				role: "INTERNAL",
				department: "BACKEND",
			});
			await addMemberRaw(world.pm, projectId, newcomer.userId);

			await removeMemberRaw(world.pm, projectId, newcomer.userId);

			const row = await db.orm.public.Users.first({ id: newcomer.userId });
			expect(row).not.toBeNull();
			// The account still works: it was removed from a project, not disabled.
			expect((await api("/auth/me", { token: newcomer.token })).status).toBe(
				200,
			);
		});

		test("an internal user cannot remove a member", async () => {
			const projectId = await ownedProject("It internal cannot remove");
			const newcomer = await ownedUser({
				name: "It Stays",
				email: `stays-${Date.now().toString(36)}@example.local`,
				role: "INTERNAL",
				department: "BACKEND",
			});
			await addMemberRaw(world.pm, projectId, newcomer.userId);

			const removed = await removeMemberRaw(
				world.engineer,
				projectId,
				newcomer.userId,
			);

			expect(removed.status).toBe(403);
			expect(await isMember(projectId, newcomer.userId)).toBe(true);
		});

		test("removing someone who is not a member is a 404", async () => {
			const projectId = await ownedProject("It not a member");
			const newcomer = await ownedUser({
				name: "It Never",
				email: `never-${Date.now().toString(36)}@example.local`,
				role: "INTERNAL",
				department: "BACKEND",
			});

			const removed = await removeMemberRaw(
				world.pm,
				projectId,
				newcomer.userId,
			);

			expect(removed.status).toBe(404);
			expect(removed.code).toBe("PROJECT_MEMBER_NOT_FOUND");
		});

		test("removing from a non-existent project is a 404 PROJECT_NOT_FOUND", async () => {
			const removed = await removeMemberRaw(
				world.pm,
				"3c9a1e8a-6d5b-4f21-9c3f-8f0d1a2b3c4d",
				world.engineer.userId,
			);

			expect(removed.status).toBe(404);
			expect(removed.code).toBe("PROJECT_NOT_FOUND");
		});

		test("an archived project refuses removals", async () => {
			const projectId = await ownedProject("It archived removal");
			const newcomer = await ownedUser({
				name: "It Stays Archived",
				email: `staysarchived-${Date.now().toString(36)}@example.local`,
				role: "INTERNAL",
				department: "BACKEND",
			});
			await addMemberRaw(world.pm, projectId, newcomer.userId);
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

			const removed = await removeMemberRaw(
				world.pm,
				projectId,
				newcomer.userId,
			);

			expect(removed.status).toBe(409);
			expect(removed.code).toBe("PROJECT_ARCHIVED");
			expect(await isMember(projectId, newcomer.userId)).toBe(true);
		});
	});

	describe("candidate search", () => {
		test("a PM can search for users by name", async () => {
			const res = await api(
				`/projects/${world.project.id}/members/candidates?search=Engineer`,
				{ token: world.pm.token },
			);

			expect(res.status).toBe(200);
			const candidates =
				jsonPath<Array<{ name: string; email: string }>>(res, [
					"data",
					"candidates",
				]) ?? [];
			expect(candidates.length).toBeGreaterThan(0);
			expect(
				candidates.every((candidate) =>
					candidate.name.toLowerCase().includes("engineer"),
				),
			).toBe(true);
		});

		test("a PM can search for users by email", async () => {
			// Matched on the address rather than the display name: the two are
			// searched by the same predicate, and either proves it works.
			const res = await api(
				`/projects/${world.project.id}/members/candidates?search=eng2`,
				{ token: world.pm.token },
			);

			expect(res.status).toBe(200);
			const candidates =
				jsonPath<Array<{ email: string }>>(res, ["data", "candidates"]) ?? [];
			expect(candidates.length).toBeGreaterThan(0);
			expect(candidates.map((candidate) => candidate.email)).toContain(
				world.otherEngineer.email,
			);
			expect(
				candidates.every((candidate) =>
					candidate.email.toLowerCase().includes("eng2"),
				),
			).toBe(true);
		});

		// The whole point of the endpoint's allow-list projection.
		test("candidates never expose passwordHash or any security field", async () => {
			const res = await api(
				`/projects/${world.project.id}/members/candidates?search=it`,
				{ token: world.pm.token },
			);

			expect(res.text).not.toContain("passwordHash");
			expect(res.text).not.toContain("password_hash");
			const candidates =
				jsonPath<Array<Record<string, unknown>>>(res, ["data", "candidates"]) ??
				[];
			for (const candidate of candidates) {
				expect(Object.keys(candidate).sort()).toEqual([
					"alreadyMember",
					"department",
					"email",
					"id",
					"name",
					"role",
				]);
			}
		});

		// A term that reaches every account the shared world provisioned and nothing
		// else. Derived from this run's id rather than the bare `it-` prefix: the
		// seeded and staged rows also contain `it-`, and a broad term matched more
		// accounts than the 20-row candidate page could hold, which pushed the
		// accounts under test off the end of the results.
		const itSearch = TEST_RUN_ID;

		test("candidates identify who is already on the project", async () => {
			const res = await api(
				`/projects/${world.project.id}/members/candidates?search=${itSearch}&rows=20`,
				{ token: world.pm.token },
			);

			const candidates =
				jsonPath<Array<{ id: string; alreadyMember: boolean }>>(res, [
					"data",
					"candidates",
				]) ?? [];

			// Everyone the shared world put on this project.
			for (const member of [
				world.pm.userId,
				world.engineer.userId,
				world.otherEngineer.userId,
				world.client.userId,
			]) {
				expect(
					candidates.find((candidate) => candidate.id === member)
						?.alreadyMember,
				).toBe(true);
			}

			// The foreign client is on the other project, so the same search has to
			// report them as addable here. This is the case that makes the flag
			// worth having: the user appears, and is not already on this project.
			expect(
				candidates.find(
					(candidate) => candidate.id === world.foreignClient.userId,
				)?.alreadyMember,
			).toBe(false);
		});

		// A prefix shorter than the minimum would match most of the organisation,
		// so it is answered with an empty page rather than a scan.
		test("a search below the minimum length returns nothing", async () => {
			for (const search of ["", "a", "   "]) {
				const res = await api(
					`/projects/${world.project.id}/members/candidates?search=${encodeURIComponent(search)}`,
					{ token: world.pm.token },
				);

				expect(res.status).toBe(200);
				expect(jsonPath<unknown[]>(res, ["data", "candidates"])).toEqual([]);
			}
		});

		test("candidate search respects the search input", async () => {
			const res = await api(
				`/projects/${world.project.id}/members/candidates?search=zzz-no-such-user-zzz`,
				{ token: world.pm.token },
			);

			expect(res.status).toBe(200);
			expect(jsonPath<unknown[]>(res, ["data", "candidates"])).toEqual([]);
			expect(jsonPath<number>(res, ["data", "pagination", "total"])).toBe(0);
		});

		// `total` is the number of matches, not the size of the page, so a client
		// can tell a full page from the end of the results.
		test("candidate search respects pagination", async () => {
			// `total`, `page` and `limit` live on the pagination envelope rather
			// than alongside the rows, which is the existing list contract.
			const page = async (rows: number, pageNumber: number) => {
				const res = await api(
					`/projects/${world.project.id}/members/candidates?search=${itSearch}&rows=${String(rows)}&page=${String(pageNumber)}`,
					{ token: world.pm.token },
				);
				return {
					candidates: jsonPath<unknown[]>(res, ["data", "candidates"]) ?? [],
					...jsonPath<{ total: number; page: number; limit: number }>(res, [
						"data",
						"pagination",
					]),
				};
			};

			const all = await page(20, 1);
			expect(all.candidates.length).toBeGreaterThan(0);
			expect(all.page).toBe(1);
			expect(all.limit).toBe(20);

			// `total` is the number of matches, not the size of the page, so a
			// client can tell a full page from the end of the results.
			const total = all.total ?? 0;
			expect(total).toBe(all.candidates.length);

			// One row on screen, the same total as the unpaged read.
			const single = await page(1, 1);
			expect(single.candidates.length).toBe(1);
			expect(single.total).toBe(total);

			// The second page holds the second row, or nothing once the results
			// have been paged past the end.
			const second = await page(1, 2);
			expect(second.page).toBe(2);
			expect(second.candidates.length).toBe(total > 1 ? 1 : 0);
			expect(second.total).toBe(total);

			// A page beyond the end is empty rather than an error, and does not
			// rewind to the first page.
			const beyond = await page(1, total + 1);
			expect(beyond.candidates.length).toBe(0);
		});

		// Paging must not let a user be skipped between two requests for the same
		// search, which is what a stable secondary sort guarantees.
		test("candidate search is stably ordered across pages", async () => {
			const idsFor = async (pageNumber: number) =>
				(
					jsonPath<Array<{ id: string }>>(
						await api(
							`/projects/${world.project.id}/members/candidates?search=${itSearch}&rows=1&page=${String(pageNumber)}`,
							{ token: world.pm.token },
						),
						["data", "candidates"],
					) ?? []
				).map((candidate) => candidate.id);

			expect(await idsFor(1)).toEqual(await idsFor(1));
			expect(await idsFor(2)).toEqual(await idsFor(2));
			// Two different pages of one search must not return the same person.
			const first = await idsFor(1);
			const second = await idsFor(2);
			if (first.length > 0 && second.length > 0) {
				expect(first[0]).not.toBe(second[0]);
			}
		});

		test("candidate search rejects an out of range page size", async () => {
			const res = await api(
				`/projects/${world.project.id}/members/candidates?search=it-&rows=500`,
				{ token: world.pm.token },
			);

			expect(res.status).toBe(400);
		});

		// The search is only as private as the project it hangs off.
		test("candidate search on a project the caller cannot reach is a 403", async () => {
			const res = await api(
				`/projects/${world.foreignProject.id}/members/candidates?search=it`,
				{ token: world.engineer.token },
			);

			expect(res.status).toBe(403);
			expect(res.text).not.toContain("@example.local");
		});

		test("candidate search on a non-existent project is a 404", async () => {
			const res = await api(
				"/projects/3c9a1e8a-6d5b-4f21-9c3f-8f0d1a2b3c4d/members/candidates?search=it",
				{ token: world.pm.token },
			);

			expect(res.status).toBe(404);
		});

		test("candidate search requires authentication", async () => {
			const res = await api(
				`/projects/${world.project.id}/members/candidates?search=it`,
			);

			expect(res.status).toBe(401);
		});
	});

	describe("membership and the rest of the product", () => {
		// Membership is scoped to one project. Removing someone from one must not
		// disturb their access to another, which is the whole point of a join row
		// rather than a flag on the user.
		test("removing from one project leaves the user's other projects intact", async () => {
			const kept = world.project.id;
			const dropped = await ownedProject("It dropped");
			const newcomer = await ownedUser({
				name: "It Partial",
				email: `partial-${Date.now().toString(36)}@example.local`,
				role: "INTERNAL",
				department: "BACKEND",
			});
			await addMemberRaw(world.pm, kept, newcomer.userId);
			await addMemberRaw(world.pm, dropped, newcomer.userId);

			await removeMemberRaw(world.pm, dropped, newcomer.userId);

			expect(
				(await api(`/projects/${kept}`, { token: newcomer.token })).status,
			).toBe(200);
			expect(
				(await api(`/projects/${dropped}`, { token: newcomer.token })).status,
			).toBe(403);
		});

		// Assignment and membership are two independent relationships, so taking the
		// membership away while a task still points at the removed person would leave
		// that task assigned to somebody who can no longer open the project it is in.
		// The removal is refused instead, with the count, so the work can be handed
		// over deliberately.
		//
		// This case previously asserted the opposite — that the removal succeeded and
		// the task survived as a dangling assignment — and it kept passing after the
		// rule changed only because `removeMemberRaw` reports the response rather
		// than asserting on it. Asserted properly here.
		test("a member who still owns unfinished work cannot be removed", async () => {
			const projectId = await ownedProject("It owns work");
			const newcomer = await ownedUser({
				name: "It Work Owner",
				email: `workowner-${Date.now().toString(36)}@example.local`,
				role: "INTERNAL",
				department: "BACKEND",
			});
			await addMemberRaw(world.pm, projectId, newcomer.userId);
			await createTask(world.pm, projectId, "It still open", {
				assignedToId: newcomer.userId,
				department: "BACKEND",
			});

			const removed = await removeMemberRaw(
				world.pm,
				projectId,
				newcomer.userId,
			);

			expect(removed.status).toBe(409);
			expect(removed.code).toBe("PROJECT_MEMBER_HAS_ACTIVE_TASKS");
			// The count is in the error so the remedy is possible: you cannot start
			// reassigning a list you cannot see.
			expect(removed.activeTaskCount).toBe(1);
			// Nothing was changed, so the work is untouched rather than orphaned.
			expect(await isMember(projectId, newcomer.userId)).toBe(true);
		});

		// Reassigning the work is the other half of the rule: once nothing is left
		// open, the same removal goes through.
		test("a member can be removed once their open work is handed over", async () => {
			const projectId = await ownedProject("It hands over work");
			const newcomer = await ownedUser({
				name: "It Hands Over",
				email: `handover-${Date.now().toString(36)}@example.local`,
				role: "INTERNAL",
				department: "BACKEND",
			});
			await addMemberRaw(world.pm, projectId, newcomer.userId);
			const taskId = await createTask(
				world.pm,
				projectId,
				"It handed over",
				{ assignedToId: newcomer.userId, department: "BACKEND" },
			);

			const row = await readTaskRow(taskId);
			await api(`/projects/${projectId}/tasks/${taskId}`, {
				method: "PATCH",
				token: world.pm.token,
				body: { assignedToId: null, version: row?.version },
			});
			const removed = await removeMemberRaw(
				world.pm,
				projectId,
				newcomer.userId,
			);

			expect(removed.status).toBe(204);
			expect(await isMember(projectId, newcomer.userId)).toBe(false);
		});

		// A finished task is history and a deleted one is on nobody's desk. Blocking
		// on either would make a member impossible to remove on a project that merely
		// has old work in it.
		test("finished and deleted tasks do not hold a member in place", async () => {
			const projectId = await ownedProject("It finished work");
			const newcomer = await ownedUser({
				name: "It Finished",
				email: `finished-${Date.now().toString(36)}@example.local`,
				role: "INTERNAL",
				department: "BACKEND",
			});
			await addMemberRaw(world.pm, projectId, newcomer.userId);

			const doneId = await createTask(world.pm, projectId, "It done", {
				assignedToId: newcomer.userId,
				department: "BACKEND",
				status: "DONE",
			});
			const openId = await createTask(world.pm, projectId, "It then deleted", {
				assignedToId: newcomer.userId,
				department: "BACKEND",
			});
			const open = await readTaskRow(openId);
			// The delete carries the version as a query parameter, like every other
			// task mutation, so a stale client cannot remove a task someone else just
			// edited.
			const deleted = await api(
				`/projects/${projectId}/tasks/${openId}?version=${String(open?.version)}`,
				{ method: "DELETE", token: world.pm.token },
			);
			expect(deleted.status).toBe(204);

			const removed = await removeMemberRaw(
				world.pm,
				projectId,
				newcomer.userId,
			);

			expect(removed.status).toBe(204);
			// Neither task was deleted or reassigned to make room: the guard refuses,
			// it does not tidy up.
			expect(await db.orm.public.Tasks.first({ id: doneId })).not.toBeNull();
		});

		// Adding a member to a project does not change what they may do anywhere
		// else: a membership grants a project, not a capability.
		test("a new member still cannot edit the project they joined", async () => {
			const projectId = await ownedProject("It joins cannot edit");
			const newcomer = await ownedUser({
				name: "It Joins",
				email: `joins-${Date.now().toString(36)}@example.local`,
				role: "INTERNAL",
				department: "FRONTEND",
			});
			await addMemberRaw(world.pm, projectId, newcomer.userId);

			const edit = await api(`/projects/${projectId}`, {
				method: "PATCH",
				token: newcomer.token,
				body: { name: "Renamed by an engineer" },
			});

			expect(edit.status).toBe(403);
		});
	});
});
