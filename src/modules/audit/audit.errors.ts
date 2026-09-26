import { HttpError } from "../../lib/http-error";

export class AuditAccessDeniedError extends HttpError {
	constructor(
		message = "You do not have permission to access task audit logs",
	) {
		super(403, "AUDIT_ACCESS_DENIED", message);
	}
}
