import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import { db } from "../../src/prisma/db";
import { toTimestamp, toVarchar } from "../../src/prisma/scalars";
import { hashInvitationToken } from "../../src/modules/invitations/invitation-token";
import {
	type Actor,
	api,
	assertSuiteIsRunnable,
	buildWorld,
	captureEmails,
	cleanupFixtures,
	createPrivilegedActor,
	databaseIsReachable,
	deleteInvitationsForProject,
	errorCode,
	itEmail,
	jsonPath,
	readInvitationRow,
	tokenFromEmail,
	type World,
} from "../helpers/harness";

// ---------------------------------------------------------------------------
// Project invitations, exercised through the HTTP surface.
//
// The property this feature exists to provide is that access is granted only by
// an explicit acceptance, by the person the invitation names, using a secret that
// exists nowhere but their inbox. So most of this suite is about what must NOT
// happen: no token in a response, no token in the database, no membership before
// acceptance, no membership for the wrong account, no second membership on
// replay, and no way for a non-PM to reach any of it.
//
// Where a case can be proved from the response alone it is also proved from the
// database, because a 201 with a correct-looking body but nothing persisted is
// still a broken feature.
// ---------------------------------------------------------------------------

let reachable = false;
let world: World;
let restoreEmails: (() => void) | null = null;

/** Accounts this suite provisions beyond the shared world. */
const ownedUserIds: string[] = [];
/** Projects this suite provisions, cleaned up after the shared fixtures. */
const ownedProjectIds: string[] = [];
/** Memberships created by acceptance, so a baseline stays reproducible. */
const ownedMembershipIds: string[] = [];

type Captured = ReturnType<typeof captureEmails>;
let mail: Captured;

beforeAll(async () => {
	reachable = await databaseIsReachable();
	if (!reachable) {
		return;
	}
	mail = captureEmails();
	restoreEmails = mail.restore;
	world = await buildWorld();
});

afterAll(async () => {
	// Child rows first, then projects, then the extra accounts. An accepted
	// invitation holds both a membership and a row referencing the project and the
	// inviter, and the inviter relation is ON DELETE RESTRICT, so anything left
	// behind would turn the account cleanup below into a constraint failure.
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
			await deleteInvitationsForProject(projectId);
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
			await db.orm.public.ProjectInvitations.where((i) =>
				i.invitedById.eq(userId),
			).delete();
			await db.orm.public.Users.where((u) => u.id.eq(userId)).delete();
		} catch {
			// best-effort
		}
	}
	ownedUserIds.length = 0;

	await cleanupFixtures();
	restoreEmails?.();
});

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** A project this suite owns, so its membership baseline is empty. */
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

/** An account that has not yet been given the address an invitation names. */
async function ownAccount(label: string, role: Actor["role"] = "CLIENT"): Promise<{
	actor: Actor;
	email: string;
}> {
	const email = itEmail(label);
	const actor =
		role === "INTERNAL"
			? await registerOwned({ label, email })
			: await createPrivilegedActor({
					role,
					email,
					department: "PRODUCT",
				});
	ownedUserIds.push(actor.userId);
	return { actor, email };
}

async function registerOwned(input: {
	label: string;
	email: string;
}): Promise<Actor> {
	const res = await api("/auth/register", {
		method: "POST",
		body: {
			name: `It ${input.label}`,
			email: input.email,
			password: "ItPass#2026",
			department: "BACKEND",
		},
	});
	const token = jsonPath<string>(res, ["data", "accessToken"]);
	const userId = jsonPath<string>(res, ["data", "user", "id"]);
	if (!token || !userId) {
		throw new Error(`fixture: could not register ${input.email}`);
	}
	return { role: "INTERNAL", userId, email: input.email, name: input.label, token };
}

/** Issues an invitation and returns the row id plus the token that was emailed. */
async function invite(
	projectId: string,
	email: string,
): Promise<{ invitationId: string; token: string }> {
	const res = await api(`/projects/${projectId}/invitations`, {
		method: "POST",
		token: world.pm.token,
		body: { email },
	});
	const invitationId = jsonPath<string>(res, ["data", "invitation", "id"]);
	if (!invitationId) {
		throw new Error(
			`fixture: invitation to ${email} failed (status=${res.status}, code=${errorCode(res)})`,
		);
	}
	return { invitationId, token: tokenFromEmail(mail.sent, email) };
}

async function membersOf(projectId: string): Promise<string[]> {
	const res = await api(`/projects/${projectId}/members`, {
		token: world.pm.token,
	});
	const rows =
		(res.json as { data?: { members?: unknown[] } } | null)?.data?.members ?? [];
	return rows.map((m) => String((m as { userId: string }).userId));
}

/**
 * Walks a project to the requested status, one legal step at a time.
 *
 * The lifecycle is `PLANNING -> ACTIVE -> COMPLETED -> ARCHIVED` with no jumps, and
 * a new project starts at PLANNING, so reaching ARCHIVED takes three requests. Each
 * one goes through the public status route rather than a direct column write,
 * because a fixture that bypassed the state machine would also bypass the check
 * that these tests are relying on.
 */
async function setStatus(
	projectId: string,
	target: "ACTIVE" | "COMPLETED" | "ARCHIVED",
): Promise<void> {
	const path: Record<typeof target, ("ACTIVE" | "COMPLETED" | "ARCHIVED")[]> = {
		ACTIVE: ["ACTIVE"],
		COMPLETED: ["ACTIVE", "COMPLETED"],
		ARCHIVED: ["ACTIVE", "COMPLETED", "ARCHIVED"],
	};

	for (const status of path[target]) {
		const res = await api(`/projects/${projectId}/status`, {
			method: "PATCH",
			token: world.pm.token,
			body: { status },
		});
		if (res.status !== 200) {
			throw new Error(
				`fixture: setting ${projectId} to ${status} failed (${errorCode(res)})`,
			);
		}
	}
}

// ---------------------------------------------------------------------------

describe("invitations: creating", () => {
	test("a PM can invite an address, and the list reports it pending", async () => {
		assertSuiteIsRunnable(reachable);
		const projectId = await ownProject("It Invite Create");
		const { email } = await ownAccount("invcreate");

		const created = await api(`/projects/${projectId}/invitations`, {
			method: "POST",
			token: world.pm.token,
			body: { email },
		});

		expect(created.status).toBe(201);
		const invitation = jsonPath<Record<string, unknown>>(
			created,
			["data", "invitation"],
		);
		expect(invitation?.status).toBe("PENDING");
		expect(invitation?.email).toBe(email);
		expect(jsonPath<string | null>(created, ["data", "invitation", "acceptedAt"])).toBeNull();

		const row = await readInvitationRow(String(invitation?.id));
		expect(row?.status).toBe("PENDING");
		expect(row?.acceptedAt).toBeNull();
	});

	test("no response, and no database row, ever contains the raw token", async () => {
		assertSuiteIsRunnable(reachable);
		const projectId = await ownProject("It Invite No Leak");
		const { email } = await ownAccount("noleak");

		const created = await api(`/projects/${projectId}/invitations`, {
			method: "POST",
			token: world.pm.token,
			body: { email },
		});
		const token = tokenFromEmail(mail.sent, email);

		// The create response, the list response, and the stored row must all be
		// blind to the token. The list matters as much as the create: it is the
		// surface a PM has open while resending, and it is where a `select *` would
		// quietly reintroduce the hash.
		const list = await api(`/projects/${projectId}/invitations`, {
			token: world.pm.token,
		});
		const row = await readInvitationRow(
			String(jsonPath<string>(created, ["data", "invitation", "id"])),
		);

		expect(created.text).not.toContain(token);
		expect(list.text).not.toContain(token);
		expect(row).not.toBeNull();
		expect(row?.tokenHash).toBeDefined();
		// The stored value is a hash, not the token: 64 hex characters, and nothing
		// like the base64url token that was emailed.
		expect(row?.tokenHash).toMatch(/^[0-9a-f]{64}$/);
		expect(row?.tokenHash).not.toContain(token);
	});

	test("the email carries the link, the project, the sender and the expiry", async () => {
		assertSuiteIsRunnable(reachable);
		const projectId = await ownProject("It Invite Email Copy");
		const { email } = await ownAccount("emailcopy");

		const created = await api(`/projects/${projectId}/invitations`, {
			method: "POST",
			token: world.pm.token,
			body: { email },
		});
		const message = mail.sent.lastTo(email);
		const projectName = String(jsonPath<string>(created, ["data", "invitation", "projectId"]));

		expect(message).toBeDefined();
		expect(message?.text).toContain("/invitations/accept?token=");
		expect(message?.text).toContain("It Invite Email Copy");
		expect(message?.text).toContain(email);
		expect(message?.html).toContain("It Invite Email Copy");
		// The correlation id ties a delivery failure to the row without putting the
		// token in the log.
		expect(message?.correlationId).toBe(
			`invitation:${String(jsonPath<string>(created, ["data", "invitation", "id"]))}`,
		);
		expect(message?.correlationId).not.toContain(tokenFromEmail(mail.sent, email));
		expect(projectName).toBe(projectId);
	});

	test("the address is normalized before it is stored or compared", async () => {
		assertSuiteIsRunnable(reachable);
		const projectId = await ownProject("It Invite Normalize");
		const { email } = await ownAccount("normalize");

		const created = await api(`/projects/${projectId}/invitations`, {
			method: "POST",
			token: world.pm.token,
			body: { email: `  ${email.toUpperCase()}  ` },
		});

		// Stored lowercase and trimmed, which is what makes the acceptance-time
		// equality against a signed-in address hold for an address typed in capitals.
		expect(jsonPath<string>(created, ["data", "invitation", "email"])).toBe(email);
		const row = await readInvitationRow(
			String(jsonPath<string>(created, ["data", "invitation", "id"])),
		);
		expect(row?.email).toBe(email);
	});

	test("an invalid address is rejected and nothing is created", async () => {
		assertSuiteIsRunnable(reachable);
		const projectId = await ownProject("It Invite Bad Address");

		const res = await api(`/projects/${projectId}/invitations`, {
			method: "POST",
			token: world.pm.token,
			body: { email: "not-an-address" },
		});

		expect(res.status).toBe(400);
		const list = await api(`/projects/${projectId}/invitations`, {
			token: world.pm.token,
		});
		expect(jsonPath<unknown[]>(list, ["data", "invitations"])).toHaveLength(0);
	});

	test("an unknown field is rejected rather than ignored", async () => {
		assertSuiteIsRunnable(reachable);
		const projectId = await ownProject("It Invite Strict Body");
		const { email } = await ownAccount("strictbody");

		const res = await api(`/projects/${projectId}/invitations`, {
			method: "POST",
			token: world.pm.token,
			body: { email, userId: world.engineer.userId },
		});

		// Strict, so a caller reaching for the existing member shape is told the
		// field does not exist instead of silently getting an invitation that will
		// not match anybody.
		expect(res.status).toBe(400);
		const list = await api(`/projects/${projectId}/invitations`, {
			token: world.pm.token,
		});
		expect(jsonPath<unknown[]>(list, ["data", "invitations"])).toHaveLength(0);
	});

	test("a second live invitation for the same address is refused", async () => {
		assertSuiteIsRunnable(reachable);
		const projectId = await ownProject("It Invite Duplicate");
		const { email } = await ownAccount("duplicate");
		await invite(projectId, email);

		const res = await api(`/projects/${projectId}/invitations`, {
			method: "POST",
			token: world.pm.token,
			body: { email },
		});

		expect(res.status).toBe(409);
		expect(errorCode(res)).toBe("INVITATION_ALREADY_PENDING");

		const list = await api(`/projects/${projectId}/invitations`, {
			token: world.pm.token,
		});
		expect(jsonPath<unknown[]>(list, ["data", "invitations"])).toHaveLength(1);
	});

	test("inviting somebody already on the project is refused", async () => {
		assertSuiteIsRunnable(reachable);
		const projectId = await ownProject("It Invite Existing Member");
		// `engineer` is a member of the shared world, not of this project, so the
		// fixture has to add them here first.
		await api(`/projects/${projectId}/members`, {
			method: "POST",
			token: world.pm.token,
			body: { userId: world.engineer.userId },
		});

		const res = await api(`/projects/${projectId}/invitations`, {
			method: "POST",
			token: world.pm.token,
			body: { email: world.engineer.email },
		});

		expect(res.status).toBe(409);
		expect(errorCode(res)).toBe("PROJECT_MEMBER_ALREADY_EXISTS");
	});

	test("a project that does not exist is a 404", async () => {
		assertSuiteIsRunnable(reachable);
		const res = await api(
			"/projects/00000000-0000-4000-8000-000000000000/invitations",
			{
				method: "POST",
				token: world.pm.token,
				body: { email: itEmail("noproject") },
			},
		);
		expect(res.status).toBe(404);
		expect(errorCode(res)).toBe("PROJECT_NOT_FOUND");
	});

	test("a malformed project id is a 400, not a lookup", async () => {
		assertSuiteIsRunnable(reachable);
		const res = await api("/projects/not-a-uuid/invitations", {
			method: "POST",
			token: world.pm.token,
			body: { email: itEmail("baduuid") },
		});
		expect(res.status).toBe(400);
	});
});

describe("invitations: authorization", () => {
	test("an internal engineer cannot list, create, resend or cancel", async () => {
		assertSuiteIsRunnable(reachable);
		const projectId = await ownProject("It Invite Internal Denied");
		const { email } = await ownAccount("internaldenied");
		const { invitationId } = await invite(projectId, email);

		const list = await api(`/projects/${projectId}/invitations`, {
			token: world.engineer.token,
		});
		const create = await api(`/projects/${projectId}/invitations`, {
			method: "POST",
			token: world.engineer.token,
			body: { email: itEmail("internaldenied2") },
		});
		const resend = await api(
			`/projects/${projectId}/invitations/${invitationId}/resend`,
			{ method: "POST", token: world.engineer.token },
		);
		const cancel = await api(
			`/projects/${projectId}/invitations/${invitationId}`,
			{ method: "DELETE", token: world.engineer.token },
		);

		for (const res of [list, create, resend, cancel]) {
			expect(res.status).toBe(403);
			expect(errorCode(res)).toBe("INVITATION_NOT_AUTHORIZED");
		}
	});

	test("a client guest is refused the whole project invitation surface", async () => {
		assertSuiteIsRunnable(reachable);
		const projectId = await ownProject("It Invite Client Denied");

		const list = await api(`/projects/${projectId}/invitations`, {
			token: world.client.token,
		});
		const create = await api(`/projects/${projectId}/invitations`, {
			method: "POST",
			token: world.client.token,
			body: { email: itEmail("clientdenied") },
		});

		expect(list.status).toBe(403);
		expect(create.status).toBe(403);
		// The same code as the engineer's refusal: an invite must not be
		// distinguishable from an add-member attempt as a probing surface.
		expect(errorCode(create)).toBe("INVITATION_NOT_AUTHORIZED");
	});

	test("an unauthenticated caller gets 401 from every route", async () => {
		assertSuiteIsRunnable(reachable);
		const projectId = await ownProject("It Invite Anonymous");

		const list = await api(`/projects/${projectId}/invitations`);
		const create = await api(`/projects/${projectId}/invitations`, {
			method: "POST",
			body: { email: itEmail("anonymous") },
		});

		expect(list.status).toBe(401);
		expect(create.status).toBe(401);
	});

	test("a PM cannot manage invitations on a project through another project's id", async () => {
		assertSuiteIsRunnable(reachable);
		const projectId = await ownProject("It Invite Cross Project");
		const foreignId = await ownProject("It Invite Cross Project Foreign");
		const { email } = await ownAccount("crossproject");
		const { invitationId } = await invite(projectId, email);

		// The invitation is addressed through a project the PM does own, so the
		// authorization passes and the *scoping* is what has to refuse. A lookup that
		// found the row and then checked the project would leak its existence.
		const res = await api(`/projects/${foreignId}/invitations/${invitationId}`, {
			method: "DELETE",
			token: world.pm.token,
		});

		expect(res.status).toBe(404);
		expect(errorCode(res)).toBe("INVITATION_NOT_FOUND");

		const row = await readInvitationRow(invitationId);
		expect(row?.status).toBe("PENDING");
	});
});

describe("invitations: lifecycle guards", () => {
	test("an archived project refuses new invitations and says so", async () => {
		assertSuiteIsRunnable(reachable);
		const projectId = await ownProject("It Invite Archived");
		await setStatus(projectId, "ARCHIVED");
		const { email } = await ownAccount("archived");

		const res = await api(`/projects/${projectId}/invitations`, {
			method: "POST",
			token: world.pm.token,
			body: { email },
		});

		expect(res.status).toBe(409);
		expect(errorCode(res)).toBe("PROJECT_ARCHIVED");
	});

	test("an archived project cannot have its pending invitations cancelled or resent", async () => {
		assertSuiteIsRunnable(reachable);
		const projectId = await ownProject("It Invite Archived Pending");
		const { email } = await ownAccount("archivedpending");
		const { invitationId } = await invite(projectId, email);
		await setStatus(projectId, "ARCHIVED");

		const resend = await api(
			`/projects/${projectId}/invitations/${invitationId}/resend`,
			{ method: "POST", token: world.pm.token },
		);
		const cancel = await api(
			`/projects/${projectId}/invitations/${invitationId}`,
			{ method: "DELETE", token: world.pm.token },
		);

		// Who is on a closed project is part of the record that was closed, so the
		// same rule that freezes membership freezes the invitations that would change
		// it. Cancelling is refused for the same reason adding a member is.
		expect(errorCode(resend)).toBe("PROJECT_ARCHIVED");
		expect(errorCode(cancel)).toBe("PROJECT_ARCHIVED");
	});

	test("a completed project still accepts invitations, matching the member flow", async () => {
		assertSuiteIsRunnable(reachable);
		const projectId = await ownProject("It Invite Completed");
		await setStatus(projectId, "COMPLETED");
		const { email } = await ownAccount("completed");

		const res = await api(`/projects/${projectId}/invitations`, {
			method: "POST",
			token: world.pm.token,
			body: { email },
		});

		// `addProjectMember` allows this, so the invitation surface must too. A
		// different rule for the same mutation would be a surprise, not a safety
		// improvement.
		expect(res.status).toBe(201);
	});

	test("an invitation to a deleted project cannot be accepted", async () => {
		assertSuiteIsRunnable(reachable);
		const projectId = await ownProject("It Invite Deleted");
		const { actor, email } = await ownAccount("deleted");
		const { token } = await invite(projectId, email);

		await api(`/projects/${projectId}`, {
			method: "DELETE",
			token: world.pm.token,
		});

		const res = await api(`/invitations/${token}/accept`, {
			method: "POST",
			token: actor.token,
		});

		expect(res.status).toBe(409);
		expect(errorCode(res)).toBe("INVITATION_PROJECT_UNAVAILABLE");
	});

	test("an invitation to an archived project cannot be accepted", async () => {
		assertSuiteIsRunnable(reachable);
		const projectId = await ownProject("It Invite Accept Archived");
		const { actor, email } = await ownAccount("acceptarchived");
		const { token } = await invite(projectId, email);
		await setStatus(projectId, "ARCHIVED");

		const res = await api(`/invitations/${token}/accept`, {
			method: "POST",
			token: actor.token,
		});

		expect(res.status).toBe(409);
		expect(errorCode(res)).toBe("INVITATION_PROJECT_UNAVAILABLE");
		// Nothing was granted: the row is untouched and the account is not a member.
		expect(await membersOf(projectId)).not.toContain(actor.userId);
		const rows = await db.orm.public.ProjectInvitations.where((i) =>
			i.tokenHash.eq(toVarchar<64>(hashInvitationToken(token))),
		).first();
		expect(rows?.status).toBe("PENDING");
	});
});

describe("invitations: resending", () => {
	test("a resend issues a different token and the old one stops working", async () => {
		assertSuiteIsRunnable(reachable);
		const projectId = await ownProject("It Invite Resend");
		const { actor, email } = await ownAccount("resend");
		const { invitationId, token: original } = await invite(projectId, email);

		const resend = await api(
			`/projects/${projectId}/invitations/${invitationId}/resend`,
			{ method: "POST", token: world.pm.token },
		);
		expect(resend.status).toBe(200);

		const issued = tokenFromEmail(mail.sent, email);
		expect(issued).not.toBe(original);

		// The old link is dead. This is the whole point of a resend: a PM who has
		// asked to rotate a token must be able to rely on the previous one being
		// useless, and the previous one is the only thing an attacker might hold.
		const withOld = await api(`/invitations/${original}/accept`, {
			method: "POST",
			token: actor.token,
		});
		expect(withOld.status).toBe(404);
		expect(errorCode(withOld)).toBe("INVITATION_NOT_FOUND");

		// The new one works, and the row is still the same invitation rather than a
		// second one.
		const withNew = await api(`/invitations/${issued}/accept`, {
			method: "POST",
			token: actor.token,
		});
		expect(withNew.status).toBe(200);
		const list = await api(`/projects/${projectId}/invitations`, {
			token: world.pm.token,
		});
		expect(jsonPath<unknown[]>(list, ["data", "invitations"])).toHaveLength(1);
	});

	test("a resend extends the expiry", async () => {
		assertSuiteIsRunnable(reachable);
		const projectId = await ownProject("It Invite Resend Expiry");
		const { email } = await ownAccount("resendexpiry");
		const { invitationId } = await invite(projectId, email);

		const before = await readInvitationRow(invitationId);
		const resend = await api(
			`/projects/${projectId}/invitations/${invitationId}/resend`,
			{ method: "POST", token: world.pm.token },
		);
		const after = await readInvitationRow(invitationId);

		expect(resend.status).toBe(200);
		// Both are seven days out, so they are not usefully comparable; what matters
		// is that the resend wrote a fresh, future expiry rather than leaving the
		// old one in place on a "PENDING" row.
		expect(after?.status).toBe("PENDING");
		expect(after?.expiresAt).not.toBeNull();
		expect(String(after?.expiresAt) >= String(before?.expiresAt)).toBe(true);
	});

	test("a canceled invitation can be revived by a resend", async () => {
		assertSuiteIsRunnable(reachable);
		const projectId = await ownProject("It Invite Resend Canceled");
		const { actor, email } = await ownAccount("resendcanceled");
		const { invitationId } = await invite(projectId, email);

		await api(`/projects/${projectId}/invitations/${invitationId}`, {
			method: "DELETE",
			token: world.pm.token,
		});
		const resend = await api(
			`/projects/${projectId}/invitations/${invitationId}/resend`,
			{ method: "POST", token: world.pm.token },
		);

		expect(resend.status).toBe(200);
		expect(jsonPath<string>(resend, ["data", "invitation", "status"])).toBe("PENDING");

		// And the revived link actually works, which is what reviving it is for.
		const token = tokenFromEmail(mail.sent, email);
		const accepted = await api(`/invitations/${token}/accept`, {
			method: "POST",
			token: actor.token,
		});
		expect(accepted.status).toBe(200);
	});

	test("an accepted invitation cannot be resent", async () => {
		assertSuiteIsRunnable(reachable);
		const projectId = await ownProject("It Invite Resend Accepted");
		const { actor, email } = await ownAccount("resendaccepted");
		const { invitationId, token } = await invite(projectId, email);
		await api(`/invitations/${token}/accept`, {
			method: "POST",
			token: actor.token,
		});

		const resend = await api(
			`/projects/${projectId}/invitations/${invitationId}/resend`,
			{ method: "POST", token: world.pm.token },
		);

		// The membership exists, so a fresh link would offer to join something they
		// are already on.
		expect(resend.status).toBe(409);
		expect(errorCode(resend)).toBe("INVITATION_ALREADY_ACCEPTED");
	});

	test("resending an unknown invitation is a 404", async () => {
		assertSuiteIsRunnable(reachable);
		const projectId = await ownProject("It Invite Resend Unknown");
		const res = await api(
			`/projects/${projectId}/invitations/00000000-0000-4000-8000-000000000000/resend`,
			{ method: "POST", token: world.pm.token },
		);
		expect(res.status).toBe(404);
		expect(errorCode(res)).toBe("INVITATION_NOT_FOUND");
	});
});

describe("invitations: cancelling", () => {
	test("a cancel stops the link working and is idempotent", async () => {
		assertSuiteIsRunnable(reachable);
		const projectId = await ownProject("It Invite Cancel");
		const { actor, email } = await ownAccount("cancel");
		const { invitationId, token } = await invite(projectId, email);

		const first = await api(
			`/projects/${projectId}/invitations/${invitationId}`,
			{ method: "DELETE", token: world.pm.token },
		);
		expect(first.status).toBe(204);

		// Cancelling again reaches the state the PM asked for, so it succeeds.
		// Answering with a conflict would only teach them to reload and retry.
		const second = await api(
			`/projects/${projectId}/invitations/${invitationId}`,
			{ method: "DELETE", token: world.pm.token },
		);
		expect(second.status).toBe(204);

		const accepted = await api(`/invitations/${token}/accept`, {
			method: "POST",
			token: actor.token,
		});
		expect(accepted.status).toBe(409);
		expect(errorCode(accepted)).toBe("INVITATION_CANCELED");
		expect(await membersOf(projectId)).not.toContain(actor.userId);
	});

	test("a canceled invitation can be invited again", async () => {
		assertSuiteIsRunnable(reachable);
		const projectId = await ownProject("It Invite Cancel Reinvite");
		const { email } = await ownAccount("cancelreinvite");
		const { invitationId } = await invite(projectId, email);
		await api(`/projects/${projectId}/invitations/${invitationId}`, {
			method: "DELETE",
			token: world.pm.token,
		});

		// The address is no longer holding a live invitation, so a fresh one is
		// allowed. This is what makes cancel a withdrawal rather than a ban.
		const res = await api(`/projects/${projectId}/invitations`, {
			method: "POST",
			token: world.pm.token,
			body: { email },
		});
		expect(res.status).toBe(201);
	});

	test("an accepted invitation cannot be cancelled", async () => {
		assertSuiteIsRunnable(reachable);
		const projectId = await ownProject("It Invite Cancel Accepted");
		const { actor, email } = await ownAccount("cancelaccepted");
		const { invitationId, token } = await invite(projectId, email);
		await api(`/invitations/${token}/accept`, {
			method: "POST",
			token: actor.token,
		});

		const res = await api(
			`/projects/${projectId}/invitations/${invitationId}`,
			{ method: "DELETE", token: world.pm.token },
		);

		// The membership it created stands. A PM who wants that gone is removing a
		// member, which is a different and separately authorized act.
		expect(res.status).toBe(409);
		expect(errorCode(res)).toBe("INVITATION_ALREADY_ACCEPTED");
	});
});

describe("invitations: acceptance", () => {
	test("accepting as the invited address creates the membership", async () => {
		assertSuiteIsRunnable(reachable);
		const projectId = await ownProject("It Invite Accept");
		const { actor, email } = await ownAccount("accept");
		const { invitationId, token } = await invite(projectId, email);

		// Before: the invitation exists and the account is not on the project. This
		// is the property the feature is built on, so it is asserted rather than
		// assumed.
		expect(await membersOf(projectId)).not.toContain(actor.userId);
		expect((await readInvitationRow(invitationId))?.status).toBe("PENDING");

		const res = await api(`/invitations/${token}/accept`, {
			method: "POST",
			token: actor.token,
		});

		expect(res.status).toBe(200);
		expect(jsonPath<string>(res, ["data", "project", "id"])).toBe(projectId);
		expect(jsonPath<string>(res, ["data", "member", "userId"])).toBe(actor.userId);
		ownedMembershipIds.push(
			String(jsonPath<string>(res, ["data", "member", "id"])),
		);

		const row = await readInvitationRow(invitationId);
		expect(row?.status).toBe("ACCEPTED");
		expect(row?.acceptedAt).not.toBeNull();

		// The membership is real, not just reported: the member list is what the
		// rest of the product authorizes against.
		expect(await membersOf(projectId)).toContain(actor.userId);
	});

	test("acceptance actually grants access, and the preview describes it first", async () => {
		assertSuiteIsRunnable(reachable);
		const projectId = await ownProject("It Invite Accept Access");
		// Internal, not a client guest: the internal project routes are refused to
		// clients outright, so a client could not demonstrate the membership working
		// through them. An internal engineer's read access *is* scoped to membership,
		// which is exactly the thing being tested.
		const { actor, email } = await ownAccount("acceptaccess", "INTERNAL");
		const { token } = await invite(projectId, email);

		// Before accepting, the account cannot open the project at all.
		const before = await api(`/projects/${projectId}`, {
			token: actor.token,
		});
		const preview = await api(`/invitations/${token}`, { token: actor.token });

		expect(before.status).toBe(403);
		expect(errorCode(before)).toBe("PROJECT_ACCESS_DENIED");
		expect(preview.status).toBe(200);
		expect(jsonPath<boolean>(preview, ["data", "invitation", "usable"])).toBe(true);
		expect(jsonPath<string>(preview, ["data", "invitation", "project", "name"])).toBe(
			"It Invite Accept Access",
		);
		expect(jsonPath<string>(preview, ["data", "invitation", "status"])).toBe("PENDING");

		await api(`/invitations/${token}/accept`, {
			method: "POST",
			token: actor.token,
		});
		const after = await api(`/projects/${projectId}`, { token: actor.token });
		expect(after.status).toBe(200);
	});

	test("a forwarded link is useless to a different account", async () => {
		assertSuiteIsRunnable(reachable);
		const projectId = await ownProject("It Invite Forwarded");
		const { email } = await ownAccount("forwardedtarget");
		const { actor: other } = await ownAccount("forwardedthief");
		const { token } = await invite(projectId, email);

		const res = await api(`/invitations/${token}/accept`, {
			method: "POST",
			token: other.token,
		});

		// The token alone is not authority. Without this, an email forwarded to a
		// colleague would hand that colleague the project.
		expect(res.status).toBe(409);
		expect(errorCode(res)).toBe("INVITATION_EMAIL_MISMATCH");
		// The message names the address, so the recipient is sent to the right
		// account instead of to a signup form.
		expect(jsonPath<string>(res, ["error", "invitedEmail"])).toBe(email);
		expect(await membersOf(projectId)).not.toContain(other.userId);
	});

	test("the preview is not usable for an account the invitation is not for", async () => {
		assertSuiteIsRunnable(reachable);
		const projectId = await ownProject("It Invite Preview Mismatch");
		const { email } = await ownAccount("previewmismatch");
		const { actor: other } = await ownAccount("previewother");
		const { token } = await invite(projectId, email);

		const preview = await api(`/invitations/${token}`, { token: other.token });

		expect(preview.status).toBe(200);
		// The pending status is still reported — the link has not been spent — but
		// `usable` is false, which is what lets the screen say "sign in as ..." rather
		// than offering a button that will fail.
		expect(jsonPath<string>(preview, ["data", "invitation", "status"])).toBe("PENDING");
		expect(jsonPath<boolean>(preview, ["data", "invitation", "usable"])).toBe(false);
	});

	test("an unknown token is a 404 with the same code as a canceled one", async () => {
		assertSuiteIsRunnable(reachable);
		const projectId = await ownProject("It Invite Bad Token");
		const { actor, email } = await ownAccount("badtoken");
		const { token } = await invite(projectId, email);

		// A token that was never issued and a token whose row is gone must be
		// indistinguishable, or this endpoint confirms guesses.
		const wrong = await api(
			`/invitations/${"A".repeat(43)}/accept`,
			{ method: "POST", token: actor.token },
		);
		const malformed = await api("/invitations/short/accept", {
			method: "POST",
			token: actor.token,
		});

		expect(wrong.status).toBe(404);
		expect(errorCode(wrong)).toBe("INVITATION_NOT_FOUND");
		expect(malformed.status).toBe(400);
		expect(jsonPath<string>(malformed, ["data", "invitation", "email"])).toBeUndefined();
		// Neither probe touched the real invitation, so it is still spendable.
		const row = await readInvitationRow(await idForToken(token));
		expect(row?.status).toBe("PENDING");
	});

	test("accepting requires authentication", async () => {
		assertSuiteIsRunnable(reachable);
		const projectId = await ownProject("It Invite Accept Anonymous");
		const { email } = await ownAccount("acceptanonymous");
		const { token } = await invite(projectId, email);

		const res = await api(`/invitations/${token}/accept`, { method: "POST" });

		expect(res.status).toBe(401);
		const list = await api(`/projects/${projectId}/invitations`, {
			token: world.pm.token,
		});
		expect(jsonPath<string>(list, ["data", "invitations", "0", "status"])).toBe(
			"PENDING",
		);
	});

	test("a replayed token is refused and creates no second membership", async () => {
		assertSuiteIsRunnable(reachable);
		const projectId = await ownProject("It Invite Replay");
		const { actor, email } = await ownAccount("replay");
		const { token } = await invite(projectId, email);

		const first = await api(`/invitations/${token}/accept`, {
			method: "POST",
			token: actor.token,
		});
		expect(first.status).toBe(200);
		ownedMembershipIds.push(
			String(jsonPath<string>(first, ["data", "member", "id"])),
		);

		const second = await api(`/invitations/${token}/accept`, {
			method: "POST",
			token: actor.token,
		});

		// Two requests, one token, one membership. The state change is guarded inside
		// the transaction, so the replay cannot produce a second row.
		expect(second.status).toBe(409);
		const codes = [errorCode(first), errorCode(second)];
		expect(codes).toContain("INVITATION_ALREADY_ACCEPTED");
		expect(await membersOf(projectId)).toHaveLength(1);
	});

	test("two concurrent accepts produce exactly one membership", async () => {
		assertSuiteIsRunnable(reachable);
		const projectId = await ownProject("It Invite Concurrent");
		const { actor, email } = await ownAccount("concurrent");
		const { token } = await invite(projectId, email);

		// Fired together rather than sequentially: the loser of a sequential pair
		// would be stopped by the `status = 'PENDING'` guard anyway, and the point
		// is that both requests pass that check before either has written.
		const results = await Promise.all([
			api(`/invitations/${token}/accept`, {
				method: "POST",
				token: actor.token,
			}),
			api(`/invitations/${token}/accept`, {
				method: "POST",
				token: actor.token,
			}),
		]);

		const statuses = results.map((r) => r.status).sort();
		expect(statuses).toEqual([200, 409]);
		const loser = results.find((r) => r.status === 409);
		expect(errorCode(loser!)).toBe("INVITATION_ALREADY_ACCEPTED");

		expect(await membersOf(projectId)).toHaveLength(1);
		const winner = results.find((r) => r.status === 200);
		ownedMembershipIds.push(
			String(jsonPath<string>(winner!, ["data", "member", "id"])),
		);
	});

	test("an account already added directly is told so, not handed a success", async () => {
		assertSuiteIsRunnable(reachable);
		const projectId = await ownProject("It Invite Already Member");
		const { actor, email } = await ownAccount("alreadymember");
		// The invitation is issued first, then the PM adds the person directly — the
		// sequence that leaves a live link pointing at somebody already on the
		// project.
		const { token } = await invite(projectId, email);
		await api(`/projects/${projectId}/members`, {
			method: "POST",
			token: world.pm.token,
			body: { userId: actor.userId },
		});

		const res = await api(`/invitations/${token}/accept`, {
			method: "POST",
			token: actor.token,
		});

		// The invitation is genuinely spent and the membership predates it, so this
		// is reported rather than dressed up as a successful acceptance.
		expect(res.status).toBe(409);
		expect(errorCode(res)).toBe("INVITATION_ALREADY_MEMBER");
		expect(await membersOf(projectId)).toHaveLength(1);
	});
});

describe("invitations: expiry", () => {
	test("a lapsed invitation reads as expired and cannot be accepted", async () => {
		assertSuiteIsRunnable(reachable);
		const projectId = await ownProject("It Invite Expired");
		const { actor, email } = await ownAccount("expired");
		const { invitationId, token } = await invite(projectId, email);

		// Moved into the past rather than waited on: the clock is the thing under
		// test, and seven days is a long time to spend proving it.
		await db.orm.public.ProjectInvitations.where((i) =>
			i.id.eq(invitationId),
		).update({ expiresAt: toTimestamp("2020-01-01T00:00:00") });

		const list = await api(`/projects/${projectId}/invitations`, {
			token: world.pm.token,
		});
		// Derived, not written: the stored row still says PENDING, and the response
		// says EXPIRED, because the link stopped working when the clock passed it and
		// a PM must not be told otherwise by a status column that has not been swept.
		expect(jsonPath<string>(list, ["data", "invitations", "0", "status"])).toBe(
			"EXPIRED",
		);
		expect((await readInvitationRow(invitationId))?.status).toBe("PENDING");

		const res = await api(`/invitations/${token}/accept`, {
			method: "POST",
			token: actor.token,
		});
		expect(res.status).toBe(409);
		expect(errorCode(res)).toBe("INVITATION_EXPIRED");
		expect(await membersOf(projectId)).not.toContain(actor.userId);
	});

	test("an expired invitation does not block a fresh one for the same address", async () => {
		assertSuiteIsRunnable(reachable);
		const projectId = await ownProject("It Invite Expire Reinvite");
		const { email } = await ownAccount("expirereinvite");
		const { invitationId } = await invite(projectId, email);
		await db.orm.public.ProjectInvitations.where((i) =>
			i.id.eq(invitationId),
		).update({ expiresAt: toTimestamp("2020-01-01T00:00:00") });

		const res = await api(`/projects/${projectId}/invitations`, {
			method: "POST",
			token: world.pm.token,
			body: { email },
		});

		// The "already pending" rule is about a *live* invitation. Refusing here would
		// make an expired link unrecoverable without a resend, for no benefit.
		expect(res.status).toBe(201);

		// And the dead row is retired rather than left to accumulate.
		const rows = await db.orm.public.ProjectInvitations.where((i) =>
			i.projectId.eq(projectId),
		).all();
		const retired = rows.filter((r) => r.id === invitationId);
		expect(retired[0]?.status).toBe("EXPIRED");
	});
});

describe("invitations: the list", () => {
	test("the list is PM-only, newest first, and shows history", async () => {
		assertSuiteIsRunnable(reachable);
		const projectId = await ownProject("It Invite List");
		const first = await ownAccount("listfirst");
		const second = await ownAccount("listsecond");
		const older = await invite(projectId, first.email);
		await invite(projectId, second.email);
		await api(`/projects/${projectId}/invitations/${older.invitationId}`, {
			method: "DELETE",
			token: world.pm.token,
		});

		const res = await api(`/projects/${projectId}/invitations`, {
			token: world.pm.token,
		});

		expect(res.status).toBe(200);
		const rows = jsonPath<Record<string, unknown>[]>(
			res,
			["data", "invitations"],
		);
		expect(rows).toHaveLength(2);
		// Newest first, so the row a PM just acted on is at the top.
		expect(rows?.[0]?.email).toBe(second.email);
		// Accepted and canceled rows are kept: "who was invited and what became of it"
		// is the question this section answers.
		expect(
			rows?.map((r) => r.status).sort(),
		).toEqual(["CANCELED", "PENDING"]);
		// The sender is named, which is what makes a pending invitation actionable.
		expect(jsonPath<string>(res, ["data", "invitations", "0", "invitedBy", "email"])).toBe(
			world.pm.email,
		);
	});

	test("the list is empty for a project with no invitations, and 404s otherwise", async () => {
		assertSuiteIsRunnable(reachable);
		const projectId = await ownProject("It Invite List Empty");

		const empty = await api(`/projects/${projectId}/invitations`, {
			token: world.pm.token,
		});
		const missing = await api(
			"/projects/00000000-0000-4000-8000-000000000000/invitations",
			{ token: world.pm.token },
		);

		expect(empty.status).toBe(200);
		expect(jsonPath<unknown[]>(empty, ["data", "invitations"])).toHaveLength(0);
		expect(missing.status).toBe(404);
		expect(errorCode(missing)).toBe("PROJECT_NOT_FOUND");
	});

	test("the list exposes nothing belonging to another project", async () => {
		assertSuiteIsRunnable(reachable);
		const mine = await ownProject("It Invite List Mine");
		const other = await ownProject("It Invite List Other");
		const { email } = await ownAccount("listscope");
		await invite(mine, email);

		const res = await api(`/projects/${other}/invitations`, {
			token: world.pm.token,
		});

		// Both projects belong to the same PM, so this is a scoping test rather than
		// an authorization one — and it is the case a missing `projectId` filter
		// would fail.
		expect(res.status).toBe(200);
		expect(jsonPath<unknown[]>(res, ["data", "invitations"])).toHaveLength(0);
		expect(res.text).not.toContain(email);
	});
});

// ---------------------------------------------------------------------------

/** The id of the invitation a token hashes to, for fixtures. */
async function idForToken(token: string): Promise<string> {
	const row = await db.orm.public.ProjectInvitations.where((i) =>
		i.tokenHash.eq(toVarchar<64>(hashInvitationToken(token))),
	).first();
	if (!row) {
		throw new Error("fixture: no invitation matched the token");
	}
	return row.id;
}
