import type {
	TaskAuthorizationContext,
	TaskStatus,
} from "../authorization/authorization.types";
import { TaskBlockedError } from "../dependencies/dependency.errors";
import { computeTaskBlockingStates } from "../dependencies/dependency.service";
import type { TaskBlockingState } from "../dependencies/dependency.types";

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

export async function validateStatusTransition(
	projectId: string,
	task: Pick<TaskAuthorizationContext, "id" | "status">,
	targetStatus: TaskStatus,
): Promise<void> {
	if (targetStatus !== "IN_PROGRESS" || task.status === "IN_PROGRESS") {
		return;
	}

	const blocking = await getTaskBlockingState(projectId, task.id);
	if (blocking.blocked) {
		throw new TaskBlockedError(blocking.blockedBy);
	}
}
