import type { TaskBlockingState } from "../dependencies/dependency.types";
import type {
	TaskAssigneeRow,
	TaskDetailResponse,
	TaskProjectRow,
	TaskRecord,
	TaskResponse,
} from "./task.types";

/**
 * Assignee summaries for a set of tasks, keyed by user id.
 *
 * Passed in rather than looked up here, so the projection stays a pure function and
 * the number of queries it implies is decided by the caller. A task list resolves
 * the whole page's assignees in one statement; a single task resolves one.
 */
export type AssigneeLookup = ReadonlyMap<string, TaskAssigneeRow>;

function toAssigneeResponse(
	task: TaskRecord,
	assignees: AssigneeLookup | undefined,
): TaskAssigneeRow | null {
	if (task.assignedToId === null) {
		return null;
	}
	// A missing entry means the account was deleted after the task was assigned.
	// The id is still reported, so the row does not silently become "unassigned" and
	// imply a person was never on it; only the display fields are missing.
	return assignees?.get(task.assignedToId) ?? null;
}

/**
 * Allow-listed task projection. Database rows are never returned directly, so a
 * new column (or an internal-only column such as `deletedAt`) can never leak into
 * the API without a deliberate decision here.
 */
export function toTaskResponse(
	task: TaskRecord,
	blocking: TaskBlockingState,
	assignees?: AssigneeLookup,
): TaskResponse {
	return {
		id: task.id,
		projectId: task.projectId,
		assignedToId: task.assignedToId,
		title: task.title,
		description: task.description,
		status: task.status,
		priority: task.priority,
		department: task.department,
		clientVisible: task.clientVisible,
		version: task.version,
		createdAt: task.createdAt,
		updatedAt: task.updatedAt,
		isBlocked: blocking.blocked,
		blockedBy: blocking.blockedBy,
		assignedTo: toAssigneeResponse(task, assignees),
	};
}

/**
 * Detail projection adds the owning project, so an internal caller never has to
 * issue a second request to render a task.
 */
export function toTaskDetailResponse(
	task: TaskRecord,
	blocking: TaskBlockingState,
	relations: {
		project: TaskProjectRow;
		assignees?: AssigneeLookup;
	},
): TaskDetailResponse {
	return {
		...toTaskResponse(task, blocking, relations.assignees),
		project: {
			id: relations.project.id,
			name: relations.project.name,
			status: relations.project.status,
		},
	};
}
