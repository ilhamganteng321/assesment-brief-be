import { HttpError } from "../../lib/http-error";

export class UnauthorizedError extends HttpError {
	constructor(message = "Authentication required") {
		super(401, "UNAUTHORIZED", message);
	}
}

export class ForbiddenError extends HttpError {
	constructor(message = "You do not have permission to perform this action") {
		super(403, "FORBIDDEN", message);
	}
}
