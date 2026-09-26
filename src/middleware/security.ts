import { createMiddleware } from "hono/factory";
import { env } from "../config/env";

export const securityHeaders = createMiddleware(async (c, next) => {
	c.header("X-Content-Type-Options", "nosniff");
	c.header("X-Frame-Options", "DENY");
	c.header("Referrer-Policy", "no-referrer");
	c.header(
		"Content-Security-Policy",
		"default-src 'none'; frame-ancestors 'none'",
	);
	c.header("X-Permitted-Cross-Domain-Policies", "none");

	if (env.NODE_ENV === "production") {
		c.header(
			"Strict-Transport-Security",
			"max-age=63072000; includeSubDomains",
		);
	}

	await next();
});
