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

/**
 * The user fields a task's assignee is allowed to carry.
 *
 * A `Pick` off the contract rather than a hand-written interface, so adding a
 * column to `users` cannot silently widen what an assignee projection returns. It
 * is also *not* the whole row: `passwordHash` is not in the list, so it is never
 * selected from the database and cannot be logged or leaked by a later edit to a
 * response builder. `role` is here because it is the same allow-list the member
 * summaries already use, and the interface genuinely needs it — the assignee
 * control shows what the person will be able to do once they pick the task up.
 */
export type TaskAssigneeRow = Pick<
	Models.public_Users,
	"id" | "name" | "email" | "role" | "department"
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
	/**
	 * The assignee, resolved, or null.
	 *
	 * On the list as well as the detail, so a table row can name the person without
	 * the browser issuing a request per task. Hydrated in one batched query per page
	 * rather than per task — see `loadAssigneeSummaries`.
	 */
	assignedTo: TaskAssigneeRow | null;
};

export type TaskDetailResponse = TaskResponse & {
	project: TaskProjectRow;
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
