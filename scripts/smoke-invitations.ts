// End-to-end smoke test for the invitation flow, through the real app.
// Run with:  bun run scripts/smoke-invitations.ts
//
// Not a test file. This exists to be run by hand after a change, and it is the
// only check that exercises the *whole* path in one process: a PM inviting an
// address, the transport printing the link, a brand new account accepting it, and
// the membership appearing in the project afterwards.

import { app } from "../src/app";
import { MemoryEmailService } from "../src/modules/email/email.providers";
import { setEmailService } from "../src/modules/email/email.service";
import { db } from "../src/prisma/db";
import { toVarchar } from "../src/prisma/scalars";

const RUN = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
const PASSWORD = "Smoke#2026Pass";

const mail = new MemoryEmailService();
const restore = setEmailService(mail);

const created: { users: string[]; projects: string[] } = {
	users: [],
	projects: [],
};

let failures = 0;

function check(label: string, ok: boolean, detail = ""): void {
	console.log(`${ok ? "  ok  " : "  FAIL"}  ${label}${detail ? ` -> ${detail}` : ""}`);
	if (!ok) {
		failures += 1;
	}
}

async function call(
	path: string,
	method: string,
	token?: string,
	body?: unknown,
): Promise<{ status: number; json: any }> {
	const headers: Record<string, string> = {};
	if (token) {
		headers.Authorization = `Bearer ${token}`;
	}
	if (body !== undefined) {
		headers["content-type"] = "application/json";
	}
	const response = await app.request(path, {
		method,
		headers,
		body: body === undefined ? undefined : JSON.stringify(body),
	});
	const text = await response.text();
	let json: unknown = null;
	try {
		json = JSON.parse(text);
	} catch {
		// non-JSON
	}
	return { status: response.status, json };
}

function data(result: { json: any }): any {
	return result.json?.data;
}

function code(result: { json: any }): string {
	return String(result.json?.error?.code ?? "");
}

async function main() {
	console.log(`\n[smoke] invitation flow ${RUN}\n`);

	// A PM. There is no API that creates one, which is the point of the auth module
	// hard-coding INTERNAL on registration.
	const pm = await db.orm.public.Users.create({
		name: toVarchar<100>("Smoke PM"),
		email: toVarchar<255>(`smoke-pm-${RUN}@example.local`),
		passwordHash: (await import("../src/modules/auth/password")).hashPassword(PASSWORD) as never,
		role: "PM",
		department: "PRODUCT",
	});
	created.users.push(pm.id);

	const login = await call("/auth/login", "POST", undefined, {
		email: `smoke-pm-${RUN}@example.local`,
		password: PASSWORD,
	});
	const pmToken = data(login)?.accessToken;
	check("a PM can sign in", Boolean(pmToken), `status=${login.status}`);

	// 1. A project to invite people to.
	const projectRes = await call("/projects", "POST", pmToken, {
		name: `Smoke Project ${RUN}`,
	});
	const projectId = data(projectRes)?.project?.id;
	created.projects.push(projectId);
	check("a project can be created", Boolean(projectId), `status=${projectRes.status}`);

	// 2. Inviting an address nobody holds an account for yet. This is the ordinary
	//    case for the feature and the reason the token cannot live in the database.
	const inviteeEmail = `smoke-invitee-${RUN}@example.local`;
	const inviteRes = await call(
		`/projects/${projectId}/invitations`,
		"POST",
		pmToken,
		{ email: inviteeEmail },
	);
	const invitationId = data(inviteRes)?.invitation?.id;
	check("the PM can invite an unknown address", Boolean(invitationId), `status=${inviteRes.status}`);
	check(
		"the response carries no token",
		!JSON.stringify(inviteRes.json).includes("/invitations/accept"),
	);

	// 3. The link exists only in the transport.
	const message = mail.lastTo(inviteeEmail);
	const token = /\/invitations\/accept\?token=([A-Za-z0-9_-]+)/.exec(message?.text ?? "")?.[1];
	check("an email was delivered with an acceptance link", Boolean(token));

	// 4. And only a hash of it is stored.
	const row = await db.orm.public.ProjectInvitations.where((i) =>
		i.id.eq(invitationId),
	).first();
	check("the stored token is a hash, not the token", row?.tokenHash !== token && /^[0-9a-f]{64}$/.test(row?.tokenHash ?? ""));

	// 5. A new account registers under the invited address. Registration always
	//    creates INTERNAL; the invitation does not and could not pick a role.
	const recipientEmail = inviteeEmail;
	const registerRes = await call("/auth/register", "POST", undefined, {
		name: "Smoke Invitee",
		email: recipientEmail,
		password: PASSWORD,
		department: "BACKEND",
	});
	created.users.push(data(registerRes)?.user?.id);
	const recipientToken = data(registerRes)?.accessToken;
	check("the invitee can register", Boolean(recipientToken), `status=${registerRes.status}`);

	// 6. Before accepting, the project is out of reach.
	const before = await call(`/projects/${projectId}`, "GET", recipientToken);
	check(
		"the invitee cannot open the project before accepting",
		before.status === 403,
		`status=${before.status} code=${code(before)}`,
	);

	// 7. The preview tells them what they are being offered.
	const preview = await call(`/invitations/${token}`, "GET", recipientToken);
	check(
		"the preview reports the invitation as usable",
		data(preview)?.invitation?.usable === true,
		`status=${preview.status}`,
	);
	check(
		"the preview names the project",
		data(preview)?.invitation?.project?.name === `Smoke Project ${RUN}`,
	);

	// 8. Accepting creates the membership and the access it grants.
	const accept = await call(`/invitations/${token}/accept`, "POST", recipientToken);
	check("the invitee can accept", accept.status === 200, `status=${accept.status} code=${code(accept)}`);
	check("acceptance names the project to open", data(accept)?.project?.id === projectId);

	const after = await call(`/projects/${projectId}`, "GET", recipientToken);
	check("the invitee can now open the project", after.status === 200, `status=${after.status}`);

	// 9. The token is spent, and the second attempt changes nothing.
	const replay = await call(`/invitations/${token}/accept`, "POST", recipientToken);
	check("the token cannot be replayed", replay.status === 409 && code(replay) === "INVITATION_ALREADY_ACCEPTED", `status=${replay.status} code=${code(replay)}`);

	const membersRes = await call(`/projects/${projectId}/members`, "GET", pmToken);
	check(
		"exactly one membership was created",
		(data(membersRes)?.members ?? []).length === 1,
		`count=${(data(membersRes)?.members ?? []).length}`,
	);

	// 10. The PM sees the whole history, not just what is pending.
	const listRes = await call(`/projects/${projectId}/invitations`, "GET", pmToken);
	const listed = data(listRes)?.invitations ?? [];
	check("the invitation list reports it accepted", listed[0]?.status === "ACCEPTED", `status=${listed[0]?.status}`);

	// 11. A wrong account holding a *pending* link is refused, with the address
	//     named. A second invitation rather than the first one, because by now the
	//     first has been accepted — and the service reports a spent token before it
	//     looks at who is asking, which is the right order: the token is dead, and
	//     that is the more important fact.
	const other = await call("/auth/register", "POST", undefined, {
		name: "Smoke Other",
		email: `smoke-other-${RUN}@example.local`,
		password: PASSWORD,
		department: "BACKEND",
	});
	created.users.push(data(other)?.user?.id);

	const otherInviteRes = await call(
		`/projects/${projectId}/invitations`,
		"POST",
		pmToken,
		{ email: `smoke-second-${RUN}@example.local` },
	);
	const otherToken = /\/invitations\/accept\?token=([A-Za-z0-9_-]+)/.exec(
		mail.lastTo(`smoke-second-${RUN}@example.local`)?.text ?? "",
	)?.[1];
	check("a second invitation can be issued", Boolean(data(otherInviteRes)?.invitation?.id) && Boolean(otherToken));

	const forwarded = await call(
		`/invitations/${otherToken}/accept`,
		"POST",
		data(other)?.accessToken,
	);
	check(
		"a forwarded link is refused",
		forwarded.status === 409 && code(forwarded) === "INVITATION_EMAIL_MISMATCH",
		`status=${forwarded.status} code=${code(forwarded)}`,
	);
	check(
		"the refusal names the invited address",
		forwarded.json?.error?.invitedEmail === `smoke-second-${RUN}@example.local`,
	);

	// The mismatch check must not have consumed the invitation: it is the
	// recipient's to accept, and a probe by a third party should not spend it.
	const stillPending = await db.orm.public.ProjectInvitations.where((i) =>
		i.id.eq(data(otherInviteRes)?.invitation?.id),
	).first();
	check("a refused mismatch leaves the invitation pending", stillPending?.status === "PENDING", `status=${stillPending?.status}`);

	// 12. And the whole surface is closed to a non-PM.
	const internalList = await call(`/projects/${projectId}/invitations`, "GET", recipientToken);
	check(
		"a non-PM cannot list the invitations",
		internalList.status === 403 && code(internalList) === "INVITATION_NOT_AUTHORIZED",
		`status=${internalList.status} code=${code(internalList)}`,
	);
}

try {
	await main();
} catch (error) {
	console.error("[smoke] threw:", error);
	failures += 1;
} finally {
	restore();
	for (const projectId of created.projects) {
		try {
			await db.orm.public.ProjectInvitations.where((i) => i.projectId.eq(projectId)).delete();
			await db.orm.public.ProjectMembers.where((m) => m.projectId.eq(projectId)).delete();
			await db.orm.public.Projects.where((p) => p.id.eq(projectId)).delete();
		} catch {
			// best-effort
		}
	}
	for (const userId of created.users) {
		try {
			await db.orm.public.ProjectMembers.where((m) => m.userId.eq(userId)).delete();
			await db.orm.public.ProjectInvitations.where((i) => i.invitedById.eq(userId)).delete();
			await db.orm.public.Users.where((u) => u.id.eq(userId)).delete();
		} catch {
			// best-effort
		}
	}

	console.log(
		failures === 0
			? "\n[smoke] OK: the invitation flow works end to end\n"
			: `\n[smoke] FAILED: ${String(failures)} check(s) did not hold\n`,
	);
	process.exit(failures === 0 ? 0 : 1);
}
