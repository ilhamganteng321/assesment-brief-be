import { HttpError } from "../../lib/http-error";

export class ProjectNotFoundError extends HttpError {
	constructor() {
		super(404, "PROJECT_NOT_FOUND", "Project not found");
	}
}

export class ProjectAccessDeniedError extends HttpError {
	constructor(message = "You do not have permission to access this project") {
		super(403, "PROJECT_ACCESS_DENIED", message);
	}
}

export class ProjectAlreadyDeletedError extends HttpError {
	constructor() {
		super(
			409,
			"PROJECT_ALREADY_DELETED",
			"This project has already been deleted",
		);
	}
}

export class ProjectMemberNotFoundError extends HttpError {
	constructor() {
		super(404, "PROJECT_MEMBER_NOT_FOUND", "Project member not found");
	}
}

export class ProjectMemberAlreadyExistsError extends HttpError {
	constructor() {
		super(
			409,
			"PROJECT_MEMBER_ALREADY_EXISTS",
			"This user is already a member of the project",
		);
	}
}

export class ProjectUserNotFoundError extends HttpError {
	constructor() {
		super(404, "USER_NOT_FOUND", "User not found");
	}
}
