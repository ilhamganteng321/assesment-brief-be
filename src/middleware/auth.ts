import { createMiddleware } from "hono/factory";
import { HttpError } from "../lib/http-error";
import {
	getCurrentUser,
	verifyAccessToken,
} from "../modules/auth/auth.service";
import type { SafeUser } from "../modules/auth/auth.types";
import { UnauthorizedError } from "../modules/authorization/authorization.errors";

export type AuthVariables = {
	user: SafeUser;
};

export const authRequired = createMiddleware<{ Variables: AuthVariables }>(
	async (c, next) => {
		const header = c.req.header("authorization");
		if (!header?.startsWith("Bearer ")) {
			throw new HttpError(
				401,
				"UNAUTHORIZED",
				"Missing or malformed Authorization header",
			);
		}

		const token = header.slice("Bearer ".length).trim();
		if (token.length === 0) {
			throw new HttpError(
				401,
				"UNAUTHORIZED",
				"Missing or malformed Authorization header",
			);
		}

		const userId = verifyAccessToken(token);
		try {
			c.set("user", await getCurrentUser(userId));
		} catch (err) {
			if (err instanceof HttpError && err.code === "USER_NOT_FOUND") {
				throw new UnauthorizedError(
					"The account for this session no longer exists",
				);
			}
			throw err;
		}
		await next();
	},
);
