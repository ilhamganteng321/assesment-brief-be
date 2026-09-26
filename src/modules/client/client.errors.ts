import { HttpError } from "../../lib/http-error";

export class ClientAccessDeniedError extends HttpError {
	constructor(message = "Only client users can access the client API") {
		super(403, "CLIENT_ACCESS_DENIED", message);
	}
}

export class ClientReadOnlyError extends HttpError {
	constructor() {
		super(403, "CLIENT_READ_ONLY", "The client API is read-only");
	}
}
