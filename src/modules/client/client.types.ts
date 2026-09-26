import type { z } from "zod";
import type { Models } from "../../prisma/contract";
import type { Pagination } from "../tasks/task.types";
import type { clientTaskListQuerySchema } from "./client.schema";

export type ClientTaskRecord = Omit<
	Models.public_Tasks,
	| "assignedTo"
	| "attachments"
	| "auditLogs"
	| "dependencies"
	| "dependents"
	| "project"
>;

export type ClientTaskDto = Pick<
	ClientTaskRecord,
	"id" | "title" | "description" | "status" | "clientVisible"
>;

export type ClientTaskMetrics = {
	total: number;
	completed: number;
	inProgress: number;
	todo: number;
	blocked: number;
};

export type ClientProgress = {
	percentage: number;
};

export type ClientProjectDto = {
	id: string;
	name: string;
	progress: ClientProgress;
	tasks: ClientTaskMetrics;
};

export type ClientDashboardResponse = {
	projects: ClientProjectDto[];
};

export type ClientTaskListResponse = {
	tasks: ClientTaskDto[];
	pagination: Pagination;
};

export type ClientTaskListQuery = z.infer<typeof clientTaskListQuerySchema>;
