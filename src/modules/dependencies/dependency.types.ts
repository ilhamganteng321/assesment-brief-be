import type { Models } from "../../prisma/contract";
import type { TaskStatus } from "../authorization/authorization.types";

/**
 * The prerequisite task as seen by a caller of the dependency API.
 *
 * `deleted` is exposed deliberately: tasks are soft deleted, so a prerequisite
 * can disappear while the edge that points at it survives. Hiding that would
 * silently unblock the dependent task, so the flag travels with the summary.
 */
export type DependencyTaskSummary = {
	id: string;
	title: string;
	status: TaskStatus;
	deleted: boolean;
};

export type TaskBlockingState = {
	blocked: boolean;
	blockedBy: DependencyTaskSummary[];
};

/**
 * The reusable "may this task start?" answer required by the assessment. It
 * carries the reasons so a status transition, a board, and a detail view can
 * all explain the same block without re-deriving it.
 */
export type CanStartTaskResult = {
	allowed: boolean;
	blockingTasks: DependencyTaskSummary[];
};

export type TaskDependencyRecord = Omit<
	Models.public_TaskDependencies,
	"dependentTask" | "dependencyTask" | "createdByUser"
>;
