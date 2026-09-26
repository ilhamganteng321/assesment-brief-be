import type { Context } from "hono";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { AUTH_JSON_BODY_LIMIT_BYTES } from "../../config/limits";
import { HttpError } from "../../lib/http-error";
import { errorResponse, successResponse } from "../../lib/response";
import type { AuthVariables } from "../../middleware/auth";
import { authRequired } from "../../middleware/auth";
import { authRateLimit } from "../../middleware/rate-limit";
import type { RequestIdVariables } from "../../middleware/request-id";
import { login, register } from "./auth.service";

type RoutesVariables = RequestIdVariables & AuthVariables;

export const authRoutes = new Hono<{ Variables: RoutesVariables }>();

authRoutes.use(
	"*",
	bodyLimit({
		maxSize: AUTH_JSON_BODY_LIMIT_BYTES,
		onError: (c) =>
			c.json(
				errorResponse(
					"PAYLOAD_TOO_LARGE",
					"Request body is too large",
					c.get("requestId"),
				),
				413,
			),
	}),
);
authRoutes.use("*", authRateLimit);

async function readJson(c: Context): Promise<unknown> {
	try {
		return await c.req.json();
	} catch {
		throw new HttpError(
			400,
			"INVALID_REQUEST",
			"Request body must be valid JSON",
		);
	}
}

authRoutes.post("/register", async (c) => {
	const result = await register(await readJson(c));
	return c.json(successResponse(result), 201);
});

authRoutes.post("/login", async (c) => {
	const result = await login(await readJson(c));
	return c.json(successResponse(result), 200);
});

authRoutes.post("/logout", authRequired, (c) => {
	return c.json({ success: true, message: "Logged out successfully" });
});

authRoutes.get("/me", authRequired, (c) => {
	return c.json(successResponse({ user: c.get("user") }));
});
