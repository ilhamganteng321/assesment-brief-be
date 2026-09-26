import type { TaskBlockingState } from "../dependencies/dependency.types";
import type {
	TaskAssigneeRow,
	TaskDetailResponse,
	TaskProjectRow,
	TaskRecord,
	TaskResponse,
} from "./task.types";

/**
 * Allow-listed task projection. Database rows are never returned directly, so a
 * new column (or an internal-only column such as `deletedAt`) can never leak into
 * the API without a deliberate decision here.
 */
export function toTaskResponse(
	task: TaskRecord,
	blocking: TaskBlockingState,
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
	};
}

/**
 * Detail projection adds the owning project and the assignee summary so an
 * internal caller never has to issue a second request to render a task.
 */
export function toTaskDetailResponse(
	task: TaskRecord,
	blocking: TaskBlockingState,
	relations: { project: TaskProjectRow; assignee: TaskAssigneeRow | null },
): TaskDetailResponse {
	return {
		...toTaskResponse(task, blocking),
		project: {
			id: relations.project.id,
			name: relations.project.name,
			status: relations.project.status,
		},
		assignedTo:
			relations.assignee === null
				? null
				: {
						id: relations.assignee.id,
						name: relations.assignee.name,
						email: relations.assignee.email,
						department: relations.assignee.department,
					},
	};
}
