import type { Context } from "hono";
import { createMiddleware } from "hono/factory";
import { env } from "../config/env";
import { errorResponse } from "../lib/response";
import type { RequestIdVariables } from "./request-id";

export type RateLimiterContext = Context<{ Variables: RequestIdVariables }>;

export interface RateLimitResult {
	count: number;
	resetAfterSeconds: number;
}

/**
 * Backend abstraction for rate-limit counters.
 *
 * The in-memory implementation below is only suitable for a single-process
 * development or demo deployment. A horizontally scaled production deployment
 * must provide a distributed store (Redis/Upstash/Cloudflare R2 or a shared DB
 * counter); the middleware only depends on this interface.
 */
export interface RateLimitStore {
	increment(
		key: string,
		windowSeconds: number,
	): Promise<RateLimitResult> | RateLimitResult;
}

type StoredEntry = {
	count: number;
	expiresAt: number;
};

export class MemoryRateLimitStore implements RateLimitStore {
	private readonly entries = new Map<string, StoredEntry>();

	constructor(private readonly maxEntries = 10_000) {}

	increment(
		key: string,
		windowSeconds: number,
	): Promise<RateLimitResult> | RateLimitResult {
		const now = Date.now();
		const windowMs = windowSeconds * 1000;

		let entry = this.entries.get(key);
		if (entry === undefined || entry.expiresAt <= now) {
			entry = { count: 0, expiresAt: now + windowMs };
			this.entries.set(key, entry);
			this.prune(now);
		}

		entry.count += 1;
		const resetAfterSeconds = Math.max(
			1,
			Math.ceil((entry.expiresAt - now) / 1000),
		);
		return { count: entry.count, resetAfterSeconds };
	}

	reset(): void {
		this.entries.clear();
	}

	private prune(now: number): void {
		if (this.entries.size <= this.maxEntries) {
			return;
		}
		for (const [key, entry] of this.entries) {
			if (entry.expiresAt <= now) {
				this.entries.delete(key);
			}
		}
	}
}

export function clientIp(c: RateLimiterContext): string {
	const forwarded = c.req.header("x-forwarded-for");
	if (forwarded !== undefined && forwarded.length > 0) {
		return forwarded.split(",")[0]?.trim() ?? "unknown";
	}
	return c.req.header("x-real-ip") ?? "unknown";
}

export function normalizeEmail(raw: string): string {
	return raw.trim().toLowerCase();
}

export function buildGeneralRateLimitKey(input: {
	method: string;
	path: string;
	ip: string;
}): string {
	return `general:${input.method}:${input.path}:${input.ip}`;
}

export function buildAuthRateLimitKey(input: {
	method: string;
	path: string;
	ip: string;
	email: string | undefined;
}): string {
	const email = input.email === undefined ? "*" : normalizeEmail(input.email);
	return `auth:${input.method}:${input.path}:${input.ip}:${email}`;
}

const AUTH_EMAIL_PATHS = new Set(["/auth/login", "/auth/register"]);

async function authEmail(c: RateLimiterContext): Promise<string | undefined> {
	if (
		!AUTH_EMAIL_PATHS.has(c.req.path) ||
		c.req.header("content-length") === "0"
	) {
		return undefined;
	}
	try {
		const body = (await c.req.json()) as unknown;
		if (
			typeof body === "object" &&
			body !== null &&
			"email" in body &&
			typeof body.email === "string"
		) {
			return normalizeEmail(body.email);
		}
	} catch {
		// The request body is not valid JSON; the route handler surfaces the
		// validation error. The rate-limit key omits the email in that case.
	}
	return undefined;
}

async function authKeyFactory(c: RateLimiterContext): Promise<string> {
	return buildAuthRateLimitKey({
		method: c.req.method,
		path: c.req.path,
		ip: clientIp(c),
		email: await authEmail(c),
	});
}

export type RateLimitMiddlewareOptions = {
	max: number;
	windowSeconds: number;
	store: RateLimitStore;
	keyFactory: (c: RateLimiterContext) => string | Promise<string>;
	skip?: (c: RateLimiterContext) => boolean | Promise<boolean>;
};

export function createRateLimitMiddleware(options: RateLimitMiddlewareOptions) {
	return createMiddleware<{ Variables: RequestIdVariables }>(
		async (c, next) => {
			if (options.skip !== undefined && (await options.skip(c))) {
				return next();
			}

			const key = await options.keyFactory(c);
			const { count, resetAfterSeconds } = await options.store.increment(
				key,
				options.windowSeconds,
			);

			const remaining = Math.max(0, options.max - count);
			c.header("RateLimit-Limit", String(options.max));
			c.header("RateLimit-Remaining", String(remaining));

			if (count > options.max) {
				c.header("Retry-After", String(resetAfterSeconds));
				return c.json(
					errorResponse(
						"RATE_LIMITED",
						"Too many requests",
						c.get("requestId"),
						{ retryAfter: resetAfterSeconds },
					),
					429,
				);
			}

			return next();
		},
	);
}

const memoryStore = new MemoryRateLimitStore();

const HEALTH_PATHS = new Set(["/health", "/health/live", "/health/ready"]);

export const generalRateLimit = createRateLimitMiddleware({
	max: env.RATE_LIMIT_MAX,
	windowSeconds: env.RATE_LIMIT_WINDOW_SECONDS,
	store: memoryStore,
	keyFactory: (c) =>
		buildGeneralRateLimitKey({
			method: c.req.method,
			path: c.req.path,
			ip: clientIp(c),
		}),
	skip: (c) => HEALTH_PATHS.has(c.req.path),
});

export const authRateLimit = createRateLimitMiddleware({
	max: env.AUTH_RATE_LIMIT,
	windowSeconds: env.AUTH_RATE_WINDOW_SECONDS,
	store: memoryStore,
	keyFactory: authKeyFactory,
});
