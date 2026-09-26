import { cors } from "hono/cors";
import { env } from "../config/env";

const DEV_ORIGINS = [
	"http://localhost:3000",
	"http://localhost:3001",
	"http://127.0.0.1:3000",
	"http://127.0.0.1:3001",
];

export function allowedOrigins(): Set<string> {
	const origins = new Set<string>();
	for (const raw of `${env.FRONTEND_URL ?? ""},${env.CORS_ORIGIN ?? ""}`.split(
		",",
	)) {
		const origin = raw.trim();
		if (origin.length > 0) {
			origins.add(origin);
		}
	}
	if (env.NODE_ENV !== "production") {
		for (const origin of DEV_ORIGINS) {
			origins.add(origin);
		}
	}
	return origins;
}

export const corsMiddleware = cors({
	origin: (origin) => (allowedOrigins().has(origin) ? origin : undefined),
	allowMethods: ["GET", "HEAD", "POST", "PATCH", "DELETE", "OPTIONS"],
	allowHeaders: ["Content-Type", "Authorization", "X-Request-ID"],
	exposeHeaders: [
		"X-Request-ID",
		"RateLimit-Limit",
		"RateLimit-Remaining",
		"Retry-After",
	],
	maxAge: 600,
});
