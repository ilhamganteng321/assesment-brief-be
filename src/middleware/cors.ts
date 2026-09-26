import { cors } from "hono/cors";
import { env } from "../config/env";

const DEV_ORIGINS = [
	"http://localhost:3000",
	"http://localhost:3001",
	"http://127.0.0.1:3000",
	"http://127.0.0.1:3001",
];

/**
 * Puts a configured origin into the exact shape a browser sends.
 *
 * An `Origin` header is scheme + host + optional non-default port, and nothing
 * else: no trailing slash, no path, no lower-casing left to the reader, no
 * explicit `:443` on an https origin. Comparing those strings literally means
 * the obvious way to write the variable silently never matches, and the whole
 * deployed frontend fails every request with nothing at boot to explain it.
 * `https://app.example.com/` is the natural thing to type, so that case alone is
 * enough to take the deployment down.
 *
 * `URL` already folds the host to lower case and drops the default port, so
 * normalising through it handles those for free. Anything that is not a bare
 * http(s) origin is rejected rather than half-matched.
 */
export function normalizeOrigin(raw: string): string | null {
	const trimmed = raw.trim();
	if (trimmed.length === 0) {
		return null;
	}

	let url: URL;
	try {
		url = new URL(trimmed);
	} catch {
		return null;
	}

	if (url.protocol !== "http:" && url.protocol !== "https:") {
		return null;
	}
	if (url.username !== "" || url.password !== "") {
		return null;
	}
	if (url.search !== "" || url.hash !== "") {
		return null;
	}
	// `/` is what a bare origin parses its empty path to; anything longer is a
	// path, which an origin header can never carry.
	if (url.pathname !== "/" && url.pathname !== "") {
		return null;
	}

	return url.origin;
}

export function allowedOrigins(): Set<string> {
	const origins = new Set<string>();
	for (const raw of `${env.FRONTEND_URL ?? ""},${env.CORS_ORIGIN ?? ""}`.split(
		",",
	)) {
		const origin = normalizeOrigin(raw);
		if (origin !== null) {
			origins.add(origin);
		}
	}
	if (env.NODE_ENV !== "production") {
		for (const raw of DEV_ORIGINS) {
			const origin = normalizeOrigin(raw);
			if (origin !== null) {
				origins.add(origin);
			}
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
