// End-to-end walk of the assignment workflow, through the real app and a real
// database. Run with:  bun run smoke:assignment
//
// Not a test file. The suites prove each rule in isolation; this proves the chain
// the product is actually built around, in one process, in the order a person
// would do it: create a task, put somebody on it, hand it over, take them off it,
// see it in their own work, and watch the version, the history and the workload
// move at each step.

import { app } from "../src/app";
import { MemoryEmailService } from "../src/modules/email/email.providers";
import { setEmailService } from "../src/modules/email/email.service";
import { db } from "../src/prisma/db";
import { toVarchar } from "../src/prisma/scalars";

const RUN = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
const PASSWORD = "Smoke#2026Pass";

const mail = new MemoryEmailService();
const restoreMail = setEmailService(mail);

const created: { users: string[]; projects: string[] } = { users: [], projects: [] };
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
) {
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
	let json: any = null;
	try {
		json = JSON.parse(text);
	} catch {
		// non-JSON
	}
	return { status: response.status, json, text };
}

const data = (r: { json: any }): any => r.json?.data;
const code = (r: { json: any }): string => String(r.json?.error?.code ?? "");
const errorField = (r: { json: any }, key: string): unknown =>
	r.json?.error?.[key];

async function register(email: string, department: string) {
	const res = await call("/auth/register", "POST", undefined, {
		name: `Smoke ${department}`,
		email,
		password: PASSWORD,
		department,
	});
	created.users.push(data(res)?.user?.id);
	return data(res)?.accessToken as string;
}

async function readTask(taskId: string) {
	return db.orm.public.Tasks.where((t) => t.id.eq(taskId)).first();
}

async function auditFor(taskId: string, column: string) {
	const rows = await db.orm.public.AuditLogs.where((a) =>
		a.taskId.eq(taskId),
	)
		.select("changedColumn", "oldValue", "newValue")
		.all();
	return rows
		.filter((row) => row.changedColumn === column)
		.map((row) => ({ oldValue: row.oldValue, newValue: row.newValue }));
}

async function main() {
	console.log(`\n[smoke] assignment workflow ${RUN}\n`);

	const { hashPassword } = await import("../src/modules/auth/password");
	const pm = await db.orm.public.Users.create({
		name: toVarchar<100>("Smoke PM"),
		email: toVarchar<255>(`sm-pm-${RUN}@example.local`),
		passwordHash: (await hashPassword(PASSWORD)) as never,
		role: "PM",
		department: "PRODUCT",
	});
	created.users.push(pm.id);
	const pmToken = data(
		await call("/auth/login", "POST", undefined, {
			email: `sm-pm-${RUN}@example.local`,
			password: PASSWORD,
		}),
	)?.accessToken;
	check("a PM can sign in", Boolean(pmToken));

	const alice = `sm-alice-${RUN}@example.local`;
	const bob = `sm-bob-${RUN}@example.local`;
	const aliceToken = await register(alice, "BACKEND");
	const bobToken = await register(bob, "BACKEND");
	const outsiderToken = await register(`sm-out-${RUN}@example.local`, "BACKEND");
	check("three engineers can register", Boolean(aliceToken && bobToken && outsiderToken));

	const projectRes = await call("/projects", "POST", pmToken, {
		name: `Smoke Assignment ${RUN}`,
	});
	const projectId = data(projectRes)?.project?.id;
	created.projects.push(projectId);
	for (const user of [pm.id, ...created.users.slice(1, 3)]) {
		await call(`/projects/${projectId}/members`, "POST", pmToken, { userId: user });
	}
	check("the project has two members", Boolean(projectId));

	// --- create with nobody on it -------------------------------------------
	const createdTask = await call(`/projects/${projectId}/tasks`, "POST", pmToken, {
		title: "Smoke build the thing",
		department: "BACKEND",
	});
	const taskId = data(createdTask)?.task?.id;
	check("a task can be created unassigned", createdTask.status === 201);
	check("it reports no assignee", data(createdTask)?.task?.assignedTo === null);

	// --- assign --------------------------------------------------------------
	const aliceId = data(await call("/auth/login", "POST", undefined, {
		email: alice,
		password: PASSWORD,
	}))?.user?.id;
	const bobId = data(await call("/auth/login", "POST", undefined, {
		email: bob,
		password: PASSWORD,
	}))?.user?.id;
	void aliceId;

	const assigned = await call(`/projects/${projectId}/tasks/${taskId}`, "PATCH", pmToken, {
		assignedToId: created.users[1],
		version: 1,
	});
	check("a PM can assign it", assigned.status === 200, `status=${assigned.status}`);
	check(
		"the response names the new assignee",
		data(assigned)?.task?.assignedTo?.name === "Smoke BACKEND",
		data(assigned)?.task?.assignedTo?.name,
	);
	check("the version moved on", data(assigned)?.task?.version === 2);
	check(
		"the assignment was recorded",
		JSON.stringify(await auditFor(taskId, "assignedToId")) ===
			JSON.stringify([{ oldValue: null, newValue: created.users[1] }]),
	);

	// --- a non-member --------------------------------------------------------
	const outsiderId = data(await call("/auth/login", "POST", undefined, {
		email: `sm-out-${RUN}@example.local`,
		password: PASSWORD,
	}))?.user?.id;
	const refused = await call(`/projects/${projectId}/tasks/${taskId}`, "PATCH", pmToken, {
		assignedToId: outsiderId,
		version: 2,
	});
	check(
		"a non-member is refused",
		refused.status === 400 && code(refused) === "TASK_ASSIGNEE_NOT_A_MEMBER",
		`status=${refused.status} code=${code(refused)}`,
	);
	check(
		"and the assignment did not move",
		(await readTask(taskId))?.assignedToId === created.users[1],
	);
	check("and the version was not consumed", (await readTask(taskId))?.version === 2);

	// --- an internal user may not reassign -----------------------------------
	const byInternal = await call(
		`/projects/${projectId}/tasks/${taskId}`,
		"PATCH",
		aliceToken,
		{ assignedToId: created.users[2], version: 2 },
	);
	check(
		"an internal user cannot reassign",
		byInternal.status === 403,
		`status=${byInternal.status} code=${code(byInternal)}`,
	);

	// --- a client guest cannot see the internal list at all -------------------
	const byClient = await call(`/projects/${projectId}/tasks`, "GET", outsiderToken);
	check("a client guest is refused the internal task list", byClient.status === 403);

	// --- reassign ------------------------------------------------------------
	const handover = await call(
		`/projects/${projectId}/tasks/${taskId}`,
		"PATCH",
		pmToken,
		{ assignedToId: created.users[2], version: 2 },
	);
	check("the PM can hand it over", handover.status === 200, `status=${handover.status}`);
	check("the version advanced once", (await readTask(taskId))?.version === 3);

	// --- a stale write loses --------------------------------------------------
	const stale = await call(`/projects/${projectId}/tasks/${taskId}`, "PATCH", pmToken, {
		assignedToId: created.users[1],
		version: 2,
	});
	check(
		"a stale write is refused",
		stale.status === 409 && code(stale) === "CONCURRENT_MODIFICATION",
		`status=${stale.status} code=${code(stale)}`,
	);
	check(
		"and the conflict hands back the current assignee",
		(
			errorField(stale, "latestTask") as
				| { assignedTo?: { id?: string } }
				| undefined
		)?.assignedTo?.id === created.users[2],
	);
	check(
		"the winner was not undone",
		(await readTask(taskId))?.assignedToId === created.users[2],
	);

	// --- My Tasks ------------------------------------------------------------
	const bobMy = await call("/tasks/my?rows=100", "GET", bobToken);
	const bobTitles = (data(bobMy)?.tasks ?? []).map((t: { title: string }) => t.title);
	check("the new assignee sees it in My Tasks", bobTitles.includes("Smoke build the thing"));
	const aliceMy = await call("/tasks/my?rows=100", "GET", aliceToken);
	check(
		"the previous assignee no longer does",
		!(data(aliceMy)?.tasks ?? []).some(
			(t: { title: string }) => t.title === "Smoke build the thing",
		),
	);
	const spoof = await call(
		`/tasks/my?filters=${encodeURIComponent(JSON.stringify({ assignedToId: created.users[1] }))}&rows=100`,
		"GET",
		bobToken,
	);
	check(
		"My Tasks cannot be pointed at somebody else",
		(data(spoof)?.tasks ?? []).every(
			(t: { assignedToId: string }) => t.assignedToId === created.users[2],
		),
	);

	// --- the unassigned filter ------------------------------------------------
	const orphans = await call(
		`/projects/${projectId}/tasks?assignedToId=unassigned`,
		"GET",
		pmToken,
	);
	check(
		"the unassigned filter finds nothing now",
		(data(orphans)?.pagination?.total ?? 0) === 0,
		`total=${String(data(orphans)?.pagination?.total)}`,
	);

	// --- unassign ------------------------------------------------------------
	const cleared = await call(
		`/projects/${projectId}/tasks/${taskId}`,
		"PATCH",
		pmToken,
		{ assignedToId: null, version: 3 },
	);
	check(
		"an explicit null removes the assignment",
		cleared.status === 200 && data(cleared)?.task?.assignedTo === null,
		`status=${cleared.status}`,
	);
	check(
		"the unassignment was recorded",
		JSON.stringify(await auditFor(taskId, "assignedToId")).includes(
			JSON.stringify({ oldValue: created.users[2], newValue: null }),
		),
	);

	const bobAfter = await call("/tasks/my?rows=100", "GET", bobToken);
	check(
		"and it leaves the recipient's My Tasks",
		!(data(bobAfter)?.tasks ?? []).some(
			(t: { title: string }) => t.title === "Smoke build the thing",
		),
	);

	// --- no-op ---------------------------------------------------------------
	// Sending the value that is already stored. No *audit* entry, because nothing
	// changed — but the version still advances, because the server performed a
	// write. That is the existing behaviour for every field, and it is the honest
	// one: a client that submitted against version 4 must not be allowed to submit
	// the same thing again against 4 while the row has moved on.
	const beforeNoop = (await readTask(taskId))?.version;
	const auditBeforeNoop = (await auditFor(taskId, "assignedToId")).length;
	const noop = await call(
		`/projects/${projectId}/tasks/${taskId}`,
		"PATCH",
		pmToken,
		{ assignedToId: null, version: beforeNoop },
	);
	check("clearing an already-unassigned task succeeds", noop.status === 200);
	check(
		"but records no further history",
		(await auditFor(taskId, "assignedToId")).length === auditBeforeNoop,
		`${String(auditBeforeNoop)} -> ${String((await auditFor(taskId, "assignedToId")).length)}`,
	);
	check(
		"and the write advanced the version, as every write does",
		(await readTask(taskId))?.version === (beforeNoop ?? 0) + 1,
	);

	// --- workload ------------------------------------------------------------
	const reAssigned = await call(
		`/projects/${projectId}/tasks/${taskId}`,
		"PATCH",
		pmToken,
		{ assignedToId: created.users[1], version: (await readTask(taskId))?.version },
	);
	check(
		"it can be assigned again",
		reAssigned.status === 200,
		`status=${reAssigned.status} code=${code(reAssigned)}`,
	);
	const metrics = await call(`/projects/${projectId}/metrics`, "GET", pmToken);
	const workload = data(metrics)?.metrics?.workload ?? [];
	check(
		"the workload lists the person carrying it",
		workload.length === 1,
		JSON.stringify(workload.map((w: { name: string }) => w.name)),
	);
	check(
		"with the right count",
		workload[0]?.openTaskCount === 1 && workload[0]?.userId === created.users[1],
		JSON.stringify(workload[0] ?? null),
	);
	check(
		"and nothing is reported as unassigned",
		data(metrics)?.metrics?.tasks?.unassigned === 0,
		`unassigned=${String(data(metrics)?.metrics?.tasks?.unassigned)}`,
	);

	// --- member removal is guarded -------------------------------------------
	const removal = await call(
		`/projects/${projectId}/members/${created.users[1]}`,
		"DELETE",
		pmToken,
	);
	check(
		"a member still carrying work cannot be removed",
		removal.status === 409 &&
			code(removal) === "PROJECT_MEMBER_HAS_ACTIVE_TASKS",
		`status=${removal.status} code=${code(removal)}`,
	);
	check("and the count is reported", errorField(removal, "activeTaskCount") === 1);

	// Once the work is handed over it goes through.
	await call(`/projects/${projectId}/tasks/${taskId}`, "PATCH", pmToken, {
		assignedToId: null,
		version: (await readTask(taskId))?.version,
	});
	const removalAfter = await call(
		`/projects/${projectId}/members/${created.users[1]}`,
		"DELETE",
		pmToken,
	);
	check(
		"and succeeds once there is nothing open",
		removalAfter.status === 204,
		`status=${removalAfter.status}`,
	);

	void bobId;
}

try {
	await main();
} catch (error) {
	console.error("[smoke] threw:", error);
	failures += 1;
} finally {
	restoreMail();
	for (const projectId of created.projects) {
		try {
			await db.orm.public.ProjectInvitations.where((i) =>
				i.projectId.eq(projectId),
			).delete();
			await db.orm.public.Tasks.where((t) => t.projectId.eq(projectId)).delete();
			await db.orm.public.ProjectMembers.where((m) =>
				m.projectId.eq(projectId),
			).delete();
			await db.orm.public.Projects.where((p) => p.id.eq(projectId)).delete();
		} catch {
			// best-effort
		}
	}
	for (const userId of created.users) {
		try {
			await db.orm.public.ProjectMembers.where((m) => m.userId.eq(userId)).delete();
			await db.orm.public.Users.where((u) => u.id.eq(userId)).delete();
		} catch {
			// best-effort
		}
	}

	console.log(
		failures === 0
			? "\n[smoke] OK: the assignment workflow works end to end\n"
			: `\n[smoke] FAILED: ${String(failures)} check(s) did not hold\n`,
	);
	process.exit(failures === 0 ? 0 : 1);
}
