import type {
	TaskAuthorizationContext,
	TaskStatus,
} from "../authorization/authorization.types";
import { TaskBlockedError } from "../dependencies/dependency.errors";
import {
	checkCanStartTask,
	computeTaskBlockingStates,
} from "../dependencies/dependency.service";
import type {
	CanStartTaskResult,
	TaskBlockingState,
} from "../dependencies/dependency.types";

const EMPTY_BLOCKING_STATE: TaskBlockingState = {
	blocked: false,
	blockedBy: [],
};

export async function getTaskBlockingState(
	projectId: string,
	taskId: string,
): Promise<TaskBlockingState> {
	const states = await computeTaskBlockingStates(projectId, [taskId]);
	return states.get(taskId) ?? EMPTY_BLOCKING_STATE;
}

export function canStartTask(blocking: TaskBlockingState): boolean {
	return !blocking.blocked;
}

/**
 * The guard every status transition goes through. Only a move into IN_PROGRESS
 * is a "start", and the decision is always made from the dependency graph that
 * the server calculated, never from anything the client claimed.
 */
export async function validateStatusTransition(
	projectId: string,
	task: Pick<TaskAuthorizationContext, "id" | "status">,
	targetStatus: TaskStatus,
): Promise<void> {
	if (targetStatus !== "IN_PROGRESS" || task.status === "IN_PROGRESS") {
		return;
	}

	const result = await checkCanStartTask(projectId, task.id);
	if (!result.allowed) {
		throw new TaskBlockedError(result.blockingTasks);
	}
}

export type { CanStartTaskResult };
