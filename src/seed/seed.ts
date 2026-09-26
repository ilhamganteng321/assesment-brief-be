import { localStorageProvider } from "../modules/attachments/storage/local.storage";
import {
	buildAuditEntries,
	createAuditLogs,
} from "../modules/audit/audit.service";
import type { TaskAuditSnapshot } from "../modules/audit/audit.types";
import { hashPassword } from "../modules/auth/password";
import { db } from "../prisma/db";
import { toVarchar } from "../prisma/scalars";

// ---------------------------------------------------------------------------
// Deterministic identifiers for the demo project. Re-running the seed is
// idempotent: every entity is looked up by its fixed key before any write, so
// reviewer-modified state is never overwritten and nothing is duplicated.
// ---------------------------------------------------------------------------

const PROJECT_ID = "11111111-1111-4111-8111-111111111111";

const TASK_IDS = {
	uiDesign: "22222222-2222-4222-8222-222222222222",
	backendApi: "33333333-3333-4333-8333-333333333333",
	frontendSlicing: "44444444-4444-4444-8444-444444444444",
	qaTesting: "55555555-5555-4555-8555-555555555555",
	deploymentPrep: "66666666-6666-4666-8666-666666666666",
} as const;

const DEPENDENCY_IDS = {
	frontendOnUiDesign: "77777777-7777-4777-8777-777777770001",
	frontendOnBackendApi: "77777777-7777-4777-8777-777777770002",
} as const;

const ATTACHMENT_IDS = {
	uiDesignPreview: "88888888-8888-4888-8888-888888880001",
	backendApiPlan: "88888888-8888-4888-8888-888888880002",
} as const;

const DEFAULT_DEMO_PASSWORD = "DemoPass#2026";

const VALID_PASSWORD_RE = /^.{8,72}$/;

type SeedAccount = {
	readonly name: string;
	readonly email: string;
	readonly password: string;
	readonly role: "PM" | "INTERNAL" | "CLIENT";
	readonly department: "PRODUCT" | "UI_UX" | "FRONTEND" | "BACKEND" | "CLIENT";
};

function buildAccounts(
	overrideEmail: string | undefined,
	overridePassword: string | undefined,
): SeedAccount[] {
	return [
		{
			name: "Priya Sharma",
			email: overrideEmail ?? "pm@aurora.demo",
			password: overridePassword ?? DEFAULT_DEMO_PASSWORD,
			role: "PM",
			department: "PRODUCT",
		},
		{
			name: "Leo Nguyen",
			email: "uiux@aurora.demo",
			password: DEFAULT_DEMO_PASSWORD,
			role: "INTERNAL",
			department: "UI_UX",
		},
		{
			name: "Maya Chen",
			email: "frontend@aurora.demo",
			password: DEFAULT_DEMO_PASSWORD,
			role: "INTERNAL",
			department: "FRONTEND",
		},
		{
			name: "Tomas Oliveira",
			email: "backend@aurora.demo",
			password: DEFAULT_DEMO_PASSWORD,
			role: "INTERNAL",
			department: "BACKEND",
		},
		{
			name: "Grace Kim",
			email: "client@aurora.demo",
			password: DEFAULT_DEMO_PASSWORD,
			role: "CLIENT",
			department: "CLIENT",
		},
	];
}

type TaskSeed = {
	readonly id: string;
	readonly title: string;
	readonly description: string;
	readonly assignedToId: string;
	readonly status: "TODO" | "BLOCKED" | "IN_PROGRESS" | "DONE";
	readonly clientVisible: boolean;
};

const PNG_BYTES = Buffer.from(
	"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
	"base64",
);

const PDF_BYTES = Buffer.from(
	"%PDF-1.4\n% A seed demo attachment for the Project Management API.\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n",
	"utf8",
);

function snapshotFor(input: {
	readonly title: string;
	readonly description: string;
	readonly assignedToId: string;
	readonly status: string;
	readonly clientVisible: boolean;
}): TaskAuditSnapshot {
	return {
		title: input.title,
		description: input.description,
		assignedToId: input.assignedToId,
		status: input.status,
		clientVisible: input.clientVisible,
		deletedAt: null,
	};
}

async function ensureAccount(account: SeedAccount): Promise<{
	id: string;
	created: boolean;
}> {
	const existing = await db.orm.public.Users.where((u) =>
		u.email.eq(toVarchar<255>(account.email)),
	)
		.select("id")
		.first();
	if (existing) {
		return { id: existing.id, created: false };
	}

	const passwordHash = await hashPassword(account.password);
	const created = await db.orm.public.Users.select(
		"id",
		"name",
		"email",
		"role",
		"department",
	).create({
		name: toVarchar<100>(account.name),
		email: toVarchar<255>(account.email),
		passwordHash,
		role: account.role,
		department: account.department,
	});
	return { id: created.id, created: true };
}

async function ensureProject(): Promise<{ created: boolean }> {
	const existing = await db.orm.public.Projects.first({ id: PROJECT_ID });
	if (existing) {
		return { created: false };
	}

	await db.orm.public.Projects.create({
		id: PROJECT_ID,
		name: toVarchar<150>("Aurora Retail Replatform"),
		description:
			"Rebuild of the Aurora retail ordering platform: catalog, checkout, and fulfilment integrations.",
		clientName: toVarchar<150>("Aurora Retail"),
		status: "ACTIVE",
	});
	return { created: true };
}

async function ensureMembership(
	projectId: string,
	userId: string,
): Promise<boolean> {
	const existing = await db.orm.public.ProjectMembers.where((member) =>
		member.projectId.eq(projectId),
	)
		.where((member) => member.userId.eq(userId))
		.select("id")
		.first();
	if (existing) {
		return false;
	}

	await db.orm.public.ProjectMembers.create({ projectId, userId });
	return true;
}

async function ensureTask(task: TaskSeed): Promise<{
	created: boolean;
	version: number;
}> {
	const existing = await db.orm.public.Tasks.where((row) => row.id.eq(task.id))
		.select("id", "version")
		.first();
	if (existing) {
		return { created: false, version: existing.version };
	}

	await db.orm.public.Tasks.create({
		id: task.id,
		projectId: PROJECT_ID,
		assignedToId: task.assignedToId,
		title: toVarchar<200>(task.title),
		description: task.description,
		status: task.status,
		clientVisible: task.clientVisible,
	});
	return { created: true, version: 1 };
}

async function ensureDependency(
	id: string,
	dependentTaskId: string,
	dependencyTaskId: string,
): Promise<boolean> {
	const existing = await db.orm.public.TaskDependencies.where((row) =>
		row.dependentTaskId.eq(dependentTaskId),
	)
		.where((row) => row.dependencyTaskId.eq(dependencyTaskId))
		.select("id")
		.first();
	if (existing) {
		return false;
	}

	await db.orm.public.TaskDependencies.create({
		id,
		dependentTaskId,
		dependencyTaskId,
	});
	return true;
}

async function writeStatusAuditTrail(input: {
	taskId: string;
	userId: string;
	beforeStatus: string;
	afterStatus: string;
	title: string;
	description: string;
	assignedToId: string;
	clientVisible: boolean;
}): Promise<number> {
	const before = snapshotFor({
		title: input.title,
		description: input.description,
		assignedToId: input.assignedToId,
		status: input.beforeStatus,
		clientVisible: input.clientVisible,
	});
	const after = snapshotFor({
		title: input.title,
		description: input.description,
		assignedToId: input.assignedToId,
		status: input.afterStatus,
		clientVisible: input.clientVisible,
	});
	const entries = buildAuditEntries({
		taskId: input.taskId,
		userId: input.userId,
		before,
		after,
	});
	const records = await createAuditLogs(db.orm.public.AuditLogs, entries);
	return records.length;
}

async function ensureAttachment(input: {
	id: string;
	taskId: string;
	uploadedById: string;
	fileName: string;
	storageKey: string;
	mimeType: string;
	bytes: Buffer;
}): Promise<{ created: boolean; fileSize: number }> {
	const existing = await db.orm.public.Attachments.first({ id: input.id });
	if (existing) {
		return { created: false, fileSize: existing.fileSize };
	}

	await localStorageProvider.upload({
		key: input.storageKey,
		bytes: input.bytes,
	});
	await db.orm.public.Attachments.create({
		id: input.id,
		taskId: input.taskId,
		uploadedById: input.uploadedById,
		fileName: toVarchar<255>(input.fileName),
		storageKey: toVarchar<255>(input.storageKey),
		mimeType: toVarchar<100>(input.mimeType),
		fileSize: input.bytes.byteLength,
	});
	return { created: true, fileSize: input.bytes.byteLength };
}

function line(text: string): void {
	console.log(`[seed] ${text}`);
}

async function main(): Promise<number> {
	const argEmail = process.argv[2];
	const argPassword = process.argv[3];

	for (const arg of [argEmail, argPassword]) {
		if (arg !== undefined && arg.length === 0) {
			console.error(
				"[seed] Optional email/password arguments must be non-empty.",
			);
			return 1;
		}
	}
	if (argPassword !== undefined && !VALID_PASSWORD_RE.test(argPassword)) {
		console.error(
			"[seed] Password must be between 8 and 72 characters (when overridden).",
		);
		return 1;
	}

	const accounts = buildAccounts(
		argEmail === undefined ? undefined : argEmail,
		argPassword === undefined ? undefined : argPassword,
	);

	try {
		await db.orm.public.Users.aggregate((aggregate) => ({
			total: aggregate.count(),
		}));
		line("database connection OK");
	} catch {
		console.error("[seed] Database is unreachable; aborting.");
		return 1;
	}

	const userIds = new Map<string, string>();
	let usersCreated = 0;
	let usersSkipped = 0;
	for (const account of accounts) {
		const { id, created } = await ensureAccount(account);
		userIds.set(account.email, id);
		if (created) {
			usersCreated += 1;
		} else {
			usersSkipped += 1;
		}
	}

	let projectCreated = false;
	try {
		({ created: projectCreated } = await ensureProject());
	} catch (error) {
		console.error(
			"[seed] Could not create the project. The fixed project id may conflict with an existing row.",
			error instanceof Error ? error.message : String(error),
		);
		return 1;
	}

	let membershipsAdded = 0;
	for (const id of userIds.values()) {
		if (await ensureMembership(PROJECT_ID, id)) {
			membershipsAdded += 1;
		}
	}

	const [pmAccount, uiuxAccount, frontendAccount, backendAccount] = accounts;
	if (!pmAccount || !uiuxAccount || !frontendAccount || !backendAccount) {
		console.error("[seed] Internal error: an account definition is missing.");
		return 1;
	}

	const pmId = userIds.get(pmAccount.email);
	const uiuxId = userIds.get(uiuxAccount.email);
	const frontendId = userIds.get(frontendAccount.email);
	const backendId = userIds.get(backendAccount.email);
	if (!pmId || !uiuxId || !frontendId || !backendId) {
		console.error("[seed] Internal error: an account id is missing.");
		return 1;
	}

	const tasks: TaskSeed[] = [
		{
			id: TASK_IDS.uiDesign,
			title: "UI Design (Home & Checkout)",
			description:
				"Finalized wireframes, visual design, and clickable prototype for the catalog and checkout flows.",
			assignedToId: uiuxId,
			status: "DONE",
			clientVisible: true,
		},
		{
			id: TASK_IDS.backendApi,
			title: "Backend API Integration",
			description:
				"Expose catalog, cart, and order endpoints and wire the backend integration test suite.",
			assignedToId: backendId,
			status: "TODO",
			clientVisible: true,
		},
		{
			id: TASK_IDS.frontendSlicing,
			title: "Frontend Slicing",
			description:
				"Implement the approved designs as responsive pages. Blocked until the UI design and the backend API integration are both complete.",
			assignedToId: frontendId,
			status: "BLOCKED",
			clientVisible: true,
		},
		{
			id: TASK_IDS.qaTesting,
			title: "QA & Testing",
			description:
				"End-to-end testing across the ordering flows and regression checks for the release candidate.",
			assignedToId: uiuxId,
			status: "IN_PROGRESS",
			clientVisible: true,
		},
		{
			id: TASK_IDS.deploymentPrep,
			title: "Deployment Prep",
			description:
				"Release notes, rollback plan, and environment checklist. Internal-only: not shown to the client portal.",
			assignedToId: backendId,
			status: "TODO",
			clientVisible: false,
		},
	];

	let tasksCreated = 0;
	let tasksSkipped = 0;
	const createdVersion = new Map<string, number>();
	for (const task of tasks) {
		const result = await ensureTask(task);
		if (result.created) {
			tasksCreated += 1;
			createdVersion.set(task.id, result.version);
		} else {
			tasksSkipped += 1;
		}
	}

	let dependenciesAdded = 0;
	if (
		await ensureDependency(
			DEPENDENCY_IDS.frontendOnUiDesign,
			TASK_IDS.frontendSlicing,
			TASK_IDS.uiDesign,
		)
	) {
		dependenciesAdded += 1;
	}
	if (
		await ensureDependency(
			DEPENDENCY_IDS.frontendOnBackendApi,
			TASK_IDS.frontendSlicing,
			TASK_IDS.backendApi,
		)
	) {
		dependenciesAdded += 1;
	}

	let auditsWritten = 0;
	if (createdVersion.has(TASK_IDS.uiDesign)) {
		auditsWritten += await writeStatusAuditTrail({
			taskId: TASK_IDS.uiDesign,
			userId: uiuxId,
			beforeStatus: "TODO",
			afterStatus: "IN_PROGRESS",
			title: "UI Design (Home & Checkout)",
			description:
				"Finalized wireframes, visual design, and clickable prototype for the catalog and checkout flows.",
			assignedToId: uiuxId,
			clientVisible: true,
		});
		auditsWritten += await writeStatusAuditTrail({
			taskId: TASK_IDS.uiDesign,
			userId: uiuxId,
			beforeStatus: "IN_PROGRESS",
			afterStatus: "DONE",
			title: "UI Design (Home & Checkout)",
			description:
				"Finalized wireframes, visual design, and clickable prototype for the catalog and checkout flows.",
			assignedToId: uiuxId,
			clientVisible: true,
		});
	}
	if (createdVersion.has(TASK_IDS.frontendSlicing)) {
		auditsWritten += await writeStatusAuditTrail({
			taskId: TASK_IDS.frontendSlicing,
			userId: pmId,
			beforeStatus: "TODO",
			afterStatus: "BLOCKED",
			title: "Frontend Slicing",
			description:
				"Implement the approved designs as responsive pages. Blocked until the UI design and the backend API integration are both complete.",
			assignedToId: frontendId,
			clientVisible: true,
		});
	}
	if (createdVersion.has(TASK_IDS.qaTesting)) {
		auditsWritten += await writeStatusAuditTrail({
			taskId: TASK_IDS.qaTesting,
			userId: uiuxId,
			beforeStatus: "TODO",
			afterStatus: "IN_PROGRESS",
			title: "QA & Testing",
			description:
				"End-to-end testing across the ordering flows and regression checks for the release candidate.",
			assignedToId: uiuxId,
			clientVisible: true,
		});
	}

	let attachmentsCreated = 0;
	let attachmentsSkipped = 0;
	const previewAttachment = await ensureAttachment({
		id: ATTACHMENT_IDS.uiDesignPreview,
		taskId: TASK_IDS.uiDesign,
		uploadedById: uiuxId,
		fileName: "checkout-flow-preview.png",
		storageKey: `tasks/${TASK_IDS.uiDesign}/checkout-flow-preview.png`,
		mimeType: "image/png",
		bytes: PNG_BYTES,
	});
	if (previewAttachment.created) {
		attachmentsCreated += 1;
	} else {
		attachmentsSkipped += 1;
	}
	const planAttachment = await ensureAttachment({
		id: ATTACHMENT_IDS.backendApiPlan,
		taskId: TASK_IDS.backendApi,
		uploadedById: backendId,
		fileName: "backend-api-plan.pdf",
		storageKey: `tasks/${TASK_IDS.backendApi}/backend-api-plan.pdf`,
		mimeType: "application/pdf",
		bytes: PDF_BYTES,
	});
	if (planAttachment.created) {
		attachmentsCreated += 1;
	} else {
		attachmentsSkipped += 1;
	}

	console.log("");
	console.log("Seed summary");
	console.log(
		`  Accounts      created: ${usersCreated}, skipped: ${usersSkipped}`,
	);
	console.log(
		`  Project       ${projectCreated ? "created" : "already present"} (${PROJECT_ID})`,
	);
	console.log(`  Memberships   added: ${membershipsAdded}`);
	console.log(
		`  Tasks         created: ${tasksCreated}, skipped: ${tasksSkipped}`,
	);
	console.log(`  Dependencies  added: ${dependenciesAdded}`);
	console.log(`  Audit lines   written: ${auditsWritten}`);
	console.log(
		`  Attachments   created: ${attachmentsCreated}, skipped: ${attachmentsSkipped}`,
	);

	console.log("");
	console.log("Demo credentials (all accounts share the same demo password)");
	console.log("  Role                 Email                    Password");
	for (const account of accounts) {
		console.log(
			`  ${account.role.padEnd(20)}${account.email.padEnd(24)}${account.password}`,
		);
	}
	if (argEmail === undefined) {
		console.log("");
		console.log(
			"To provision the PM with your own login, run: bun run seed <email> <password>",
		);
	}

	return 0;
}

const exitCode = await main();
await db.close().catch(() => {});
process.exit(exitCode);
