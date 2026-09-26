import type { z } from "zod";
import type { Models } from "../../prisma/contract";
import type { Pagination } from "../tasks/task.types";
import type { AuditableColumn, auditListQuerySchema } from "./audit.schema";

export type AuditLogRecord = Omit<Models.public_AuditLogs, "task" | "user">;

export type AuditLogResponse = Pick<
	AuditLogRecord,
	| "id"
	| "taskId"
	| "userId"
	| "changedColumn"
	| "oldValue"
	| "newValue"
	| "createdAt"
>;

export type AuditLogsListResponse = {
	auditLogs: AuditLogResponse[];
	pagination: Pagination;
};

export type AuditListQuery = z.infer<typeof auditListQuerySchema>;

export type AuditValue =
	| string
	| number
	| boolean
	| { toString(): string }
	| null;

export type TaskAuditSnapshot = {
	title: AuditValue;
	description: AuditValue;
	assignedToId: AuditValue;
	status: AuditValue;
	clientVisible: AuditValue;
	deletedAt: AuditValue;
};

export type AuditLogEntry = {
	taskId: string;
	userId: string;
	changedColumn: AuditableColumn;
	oldValue: string | null;
	newValue: string | null;
};
