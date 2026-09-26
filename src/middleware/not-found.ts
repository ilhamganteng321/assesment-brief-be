import type { NotFoundHandler } from "hono";
import { errorResponse } from "../lib/response";

export const notFoundHandler: NotFoundHandler<{
	Variables: { requestId: string };
}> = (c) =>
	c.json(
		errorResponse(
			"NOT_FOUND",
			"The requested resource was not found",
			c.get("requestId"),
		),
		404,
	);
