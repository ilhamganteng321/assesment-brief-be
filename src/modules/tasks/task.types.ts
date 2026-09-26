import type { z } from "zod";
import type { Models } from "../../prisma/contract";
import type { DependencyTaskSummary } from "../dependencies/dependency.types";
import type {
	createFlatTaskSchema,
	createTaskSchema,
	TASK_DEPARTMENTS,
	TASK_PRIORITIES,
	TaskListQuery as TaskOfficialListQuery,
	taskListQuerySchema,
	updateTaskSchema,
} from "./task.schema";

export type TaskRecord = Omit<
	Models.public_Tasks,
	| "assignedTo"
	| "attachments"
	| "auditLogs"
	| "dependencies"
	| "dependents"
	| "project"
>;

export type TaskProjectRow = Pick<
	Models.public_Projects,
	"id" | "name" | "status"
>;

export type TaskAssigneeRow = Pick<
	Models.public_Users,
	"id" | "name" | "email" | "department"
>;

export type TaskResponse = Pick<
	TaskRecord,
	| "id"
	| "projectId"
	| "assignedToId"
	| "title"
	| "description"
	| "status"
	| "priority"
	| "department"
	| "clientVisible"
	| "version"
	| "createdAt"
	| "updatedAt"
> & {
	isBlocked: boolean;
	blockedBy: DependencyTaskSummary[];
};

export type TaskDetailResponse = TaskResponse & {
	project: TaskProjectRow;
	assignedTo: TaskAssigneeRow | null;
};

export type Pagination = {
	page: number;
	limit: number;
	total: number;
	totalPages: number;
};

export type TaskListResponse = {
	tasks: TaskResponse[];
	pagination: Pagination;
};

export type CreateTaskInput = z.infer<typeof createTaskSchema>;
export type CreateFlatTaskInput = z.infer<typeof createFlatTaskSchema>;
export type UpdateTaskInput = z.infer<typeof updateTaskSchema>;
export type TaskListQuery = z.infer<typeof taskListQuerySchema>;
export type TaskOfficialListQueryInput = TaskOfficialListQuery;

export type TaskPriority = (typeof TASK_PRIORITIES)[number];
export type TaskDepartment = (typeof TASK_DEPARTMENTS)[number];
