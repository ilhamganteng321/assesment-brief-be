import { HttpError } from "../../lib/http-error";
import type { TaskResponse } from "./task.types";

export class TaskNotFoundError extends HttpError {
	constructor() {
		super(404, "TASK_NOT_FOUND", "Task not found");
	}
}

export class TaskVersionConflictError extends HttpError {
	constructor(
		taskId: string,
		expectedVersion: number,
		currentVersion: number,
		latestTask?: TaskResponse,
	) {
		super(
			409,
			"TASK_VERSION_CONFLICT",
			"Task has been modified by another user.",
			{
				taskId,
				expectedVersion,
				currentVersion,
				...(latestTask ? { latestTask } : {}),
			},
		);
	}
}

export class TaskAccessDeniedError extends HttpError {
	constructor(message = "You do not have permission to access this task") {
		super(403, "TASK_ACCESS_DENIED", message);
	}
}

export class TaskAlreadyDeletedError extends HttpError {
	constructor() {
		super(409, "TASK_ALREADY_DELETED", "This task has already been deleted");
	}
}

export class TaskAssigneeNotMemberError extends HttpError {
	constructor() {
		super(
			400,
			"TASK_ASSIGNEE_NOT_A_MEMBER",
			"The assigned user must be a member of the project",
		);
	}
}

export class TaskAssigneeNotEligibleError extends HttpError {
	constructor() {
		super(
			400,
			"TASK_ASSIGNEE_NOT_ELIGIBLE",
			"The assigned user is not eligible for task assignment",
		);
	}
}

export class TaskDepartmentMismatchError extends HttpError {
	constructor(assigneeDepartment: string, taskDepartment: string) {
		super(
			400,
			"TASK_DEPARTMENT_MISMATCH",
			`The assigned user belongs to the ${assigneeDepartment} department, which cannot own a ${taskDepartment} task`,
			{ assigneeDepartment, taskDepartment },
		);
	}
}
