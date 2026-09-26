import type { ErrorHandler } from "hono";
import { ZodError } from "zod";
import { env } from "../config/env";
import { HttpError } from "../lib/http-error";
import { errorResponse } from "../lib/response";

export const errorHandler: ErrorHandler = (err, c) => {
	const requestId = c.get("requestId") ?? "unknown";

	if (err instanceof HttpError) {
		return c.json(
			errorResponse(err.code, err.message, requestId, err.details),
			err.status,
		);
	}

	if (err instanceof ZodError) {
		const firstIssue = err.issues[0];
		const detail = firstIssue
			? `${firstIssue.path.join(".")}: ${firstIssue.message}`
			: "Invalid request body";
		return c.json(errorResponse("INVALID_REQUEST", detail, requestId), 400);
	}

	const isProduction = env.NODE_ENV === "production";

	if (isProduction) {
		const detail =
			err instanceof Error ? (err.stack ?? err.message) : String(err);
		console.error(`[error] requestId=${requestId}: ${detail}`);
	} else {
		console.error(`[error] requestId=${requestId}`, err);
	}

	return c.json(
		errorResponse("INTERNAL_SERVER_ERROR", "Internal server error", requestId),
		500,
	);
};
