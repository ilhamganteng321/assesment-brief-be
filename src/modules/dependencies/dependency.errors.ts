import { HttpError } from "../../lib/http-error";
import type { DependencyTaskSummary } from "./dependency.types";

export class DependencyAccessDeniedError extends HttpError {
	constructor(
		message = "You do not have permission to manage task dependencies",
	) {
		super(403, "DEPENDENCY_ACCESS_DENIED", message);
	}
}

export class DependencyNotFoundError extends HttpError {
	constructor() {
		super(404, "DEPENDENCY_NOT_FOUND", "Dependency not found");
	}
}

export class DependencyAlreadyExistsError extends HttpError {
	constructor() {
		super(409, "DEPENDENCY_ALREADY_EXISTS", "This dependency already exists");
	}
}

export class SelfDependencyError extends HttpError {
	constructor() {
		super(400, "SELF_DEPENDENCY", "Task cannot depend on itself");
	}
}

export class CircularDependencyError extends HttpError {
	constructor() {
		super(
			409,
			"CIRCULAR_DEPENDENCY",
			"Creating this dependency would create a circular dependency",
		);
	}
}

export class CrossProjectDependencyError extends HttpError {
	constructor() {
		super(
			400,
			"CROSS_PROJECT_DEPENDENCY",
			"Dependencies must be between tasks in the same project",
		);
	}
}

export class TaskBlockedError extends HttpError {
	constructor(blockedBy: readonly DependencyTaskSummary[]) {
		super(
			409,
			"TASK_BLOCKED",
			"Task cannot be moved to IN_PROGRESS because required dependencies are not completed",
			{
				blockedBy: blockedBy.map((dependency) => ({ ...dependency })),
			},
		);
	}
}
