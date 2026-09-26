import type { Models } from "../../prisma/contract";
import { db } from "../../prisma/db";
import {
	nowTimestamp,
	type TimestampValue,
	toVarchar,
} from "../../prisma/scalars";
import type {
	ProjectAuthorizationContext,
	UserContext,
} from "../authorization/authorization.types";
import { ProjectNotFoundError } from "../projects/project.errors";
import { TaskNotFoundError } from "../tasks/task.errors";
import { AuditAccessDeniedError } from "./audit.errors";
import { canViewTaskAuditLogs } from "./audit.policy";
import type { AuditableColumn } from "./audit.schema";
import type {
	AuditListQuery,
	AuditLogEntry,
	AuditLogRecord,
	AuditLogResponse,
	AuditLogsListResponse,
	AuditValue,
	TaskAuditSnapshot,
} from "./audit.types";

type ProjectRow = Omit<Models.public_Projects, "members" | "tasks">;

async function findVisibleProject(
	projectId: string,
): Promise<ProjectRow | null> {
	return db.orm.public.Projects.where((project) => project.id.eq(projectId))
		.where((project) => project.deletedAt.isNull())
		.first();
}

async function loadMemberIds(projectId: string): Promise<string[]> {
	const members = await db.orm.public.ProjectMembers.where((member) =>
		member.projectId.eq(projectId),
	)
		.select("userId")
		.all();
	return members.map((member) => member.userId);
}

function toProjectContext(
	project: Pick<ProjectRow, "id" | "status">,
	memberIds: readonly string[],
): ProjectAuthorizationContext {
	return {
		id: project.id,
		status: project.status,
		memberships: memberIds.map((userId) => ({ userId })),
	};
}

export function serializeAuditValue(
	value: AuditValue | undefined,
): string | null {
	if (value === null || value === undefined) {
		return null;
	}
	if (typeof value === "boolean") {
		return value ? "true" : "false";
	}
	return value.toString();
}

const AUDIT_FIELD_ORDER: readonly {
	readonly column: AuditableColumn;
	readonly name: keyof TaskAuditSnapshot;
}[] = [
	{ column: "title", name: "title" },
	{ column: "description", name: "description" },
	{ column: "assignedToId", name: "assignedToId" },
	{ column: "status", name: "status" },
	{ column: "clientVisible", name: "clientVisible" },
	{ column: "deletedAt", name: "deletedAt" },
];

export function buildAuditEntries(input: {
	taskId: string;
	userId: string;
	before: TaskAuditSnapshot;
	after: TaskAuditSnapshot;
}): AuditLogEntry[] {
	const entries: AuditLogEntry[] = [];
	for (const field of AUDIT_FIELD_ORDER) {
		const oldValue = input.before[field.name];
		const newValue = input.after[field.name];
		if (oldValue === newValue) {
			continue;
		}
		entries.push({
			taskId: input.taskId,
			userId: input.userId,
			changedColumn: field.column,
			oldValue: serializeAuditValue(oldValue),
			newValue: serializeAuditValue(newValue),
		});
	}
	return entries;
}

export type AuditLogsTable = Pick<typeof db.orm.public.AuditLogs, "create">;

async function insertAuditLogs(
	table: AuditLogsTable,
	entries: readonly AuditLogEntry[],
	createdAt: TimestampValue,
): Promise<AuditLogRecord[]> {
	const records: AuditLogRecord[] = [];
	for (const entry of entries) {
		const record = await table.create({
			taskId: entry.taskId,
			userId: entry.userId,
			changedColumn: toVarchar<100>(entry.changedColumn),
			oldValue: entry.oldValue,
			newValue: entry.newValue,
			createdAt,
		});
		records.push(record);
	}
	return records;
}

export async function createAuditLog(
	table: AuditLogsTable,
	entry: AuditLogEntry,
): Promise<AuditLogRecord> {
	const records = await insertAuditLogs(table, [entry], nowTimestamp());
	const record = records[0];
	if (!record) {
		throw new Error("Audit log insert returned no record");
	}
	return record;
}

export async function createAuditLogs(
	table: AuditLogsTable,
	entries: readonly AuditLogEntry[],
): Promise<AuditLogRecord[]> {
	if (entries.length === 0) {
		return [];
	}

	return insertAuditLogs(table, entries, nowTimestamp());
}

function toAuditLogResponse(record: AuditLogRecord): AuditLogResponse {
	return {
		id: record.id,
		taskId: record.taskId,
		userId: record.userId,
		changedColumn: record.changedColumn,
		oldValue: record.oldValue,
		newValue: record.newValue,
		createdAt: record.createdAt,
	};
}

export async function getTaskAuditLogs(
	user: UserContext,
	projectId: string,
	taskId: string,
	query: AuditListQuery,
): Promise<AuditLogsListResponse> {
	const project = await findVisibleProject(projectId);
	if (!project) {
		throw new ProjectNotFoundError();
	}

	const memberIds = await loadMemberIds(project.id);
	const projectContext = toProjectContext(project, memberIds);

	const task = await db.orm.public.Tasks.where((row) => row.id.eq(taskId))
		.where((row) => row.projectId.eq(project.id))
		.first();
	if (!task) {
		throw new TaskNotFoundError();
	}

	if (!canViewTaskAuditLogs(user, projectContext)) {
		throw new AuditAccessDeniedError();
	}

	const page = query.page;
	const limit = query.limit;
	const changedColumn = query.changedColumn;

	let collection = db.orm.public.AuditLogs.where((row) =>
		row.taskId.eq(task.id),
	);
	if (changedColumn !== undefined) {
		collection = collection.where((row) =>
			row.changedColumn.eq(toVarchar<100>(changedColumn)),
		);
	}

	const countResult = await collection.aggregate((aggregate) => ({
		total: aggregate.count(),
	}));
	const records = await collection
		.orderBy((row) => row.createdAt.desc())
		.orderBy((row) => row.id.desc())
		.limit(limit)
		.offset((page - 1) * limit)
		.all();

	return {
		auditLogs: records.map(toAuditLogResponse),
		pagination: {
			page,
			limit,
			total: countResult.total,
			totalPages: Math.ceil(countResult.total / limit),
		},
	};
}
