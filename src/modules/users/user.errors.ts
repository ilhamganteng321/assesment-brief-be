import { HttpError } from "../../lib/http-error";

export class UserNotFoundError extends HttpError {
	constructor() {
		super(404, "USER_NOT_FOUND", "User not found");
	}
}

/**
 * The caller may not read the directory.
 *
 * The message is specific about *what* is refused rather than a bare "access
 * denied", because the two refusals a caller can hit mean different things: a
 * client is being told the directory is not for them, whereas a role that simply
 * lacks `USER_READ` is told the same. Neither reveals whether the account exists.
 */
export class UserDirectoryAccessDeniedError extends HttpError {
	constructor(
		message = "You do not have permission to browse the team directory",
	) {
		super(403, "USER_DIRECTORY_ACCESS_DENIED", message);
	}
}
