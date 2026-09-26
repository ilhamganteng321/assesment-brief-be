import type { ContentfulStatusCode } from "hono/utils/http-status";

export class HttpError extends Error {
	readonly status: ContentfulStatusCode;
	readonly code: string;
	readonly details?: Record<string, unknown>;

	constructor(
		status: ContentfulStatusCode,
		code: string,
		message: string,
		details?: Record<string, unknown>,
	) {
		super(message);
		this.name = "HttpError";
		this.status = status;
		this.code = code;
		this.details = details;
	}
}
