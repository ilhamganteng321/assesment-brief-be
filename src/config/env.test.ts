import { describe, expect, test } from "bun:test";

import { envSchema } from "./env";

// ---------------------------------------------------------------------------
// Environment validation (assessment section 30).
//
// The schema is what stands between a misconfigured deployment and a service
// that boots anyway, so the rules are pinned here rather than left to the boot
// path. The two production-only rules matter most: a deployment that comes up
// with a weak signing secret, or with no configured frontend origin and
// therefore no CORS allow-list, is worse than one that refuses to start.
//
// `env.ts` calls `process.exit(1)` when the real environment is invalid, so
// these tests exercise the exported schema directly rather than importing the
// module under a doctored `process.env`.
// ---------------------------------------------------------------------------

/** The smallest environment that boots, used as the base for each case. */
const valid = {
	DATABASE_URL: "postgresql://user:password@localhost:5432/app",
	JWT_SECRET: "a-secret-that-is-long-enough-for-production-use",
	NODE_ENV: "development",
} as const;

const issuesFor = (
	overrides: Record<string, unknown>,
): readonly { path: string; message: string }[] => {
	const result = envSchema.safeParse({ ...valid, ...overrides });
	return result.success
		? []
		: result.error.issues.map((issue) => ({
				path: issue.path.join("."),
				message: issue.message,
			}));
};

describe("environment schema", () => {
	test("a minimal development environment is accepted", () => {
		expect(issuesFor({})).toEqual([]);
	});

	describe("required values", () => {
		test("a missing database url is refused", () => {
			const result = envSchema.safeParse({
				JWT_SECRET: valid.JWT_SECRET,
				NODE_ENV: "development",
			});
			expect(result.success).toBe(false);
			expect(issuesFor({ DATABASE_URL: undefined }).length).toBeGreaterThan(0);
		});

		test("a database url that is not a url is refused", () => {
			expect(issuesFor({ DATABASE_URL: "not a url" }).length).toBeGreaterThan(
				0,
			);
		});

		test("a missing node environment is refused rather than defaulted", () => {
			const result = envSchema.safeParse({
				DATABASE_URL: valid.DATABASE_URL,
				JWT_SECRET: valid.JWT_SECRET,
			});
			expect(result.success).toBe(false);
		});

		test("an unknown node environment is refused", () => {
			expect(issuesFor({ NODE_ENV: "staging" }).length).toBeGreaterThan(0);
		});
	});

	describe("defaults", () => {
		test("the optional values fall back to documented defaults", () => {
			const result = envSchema.parse(valid);

			expect(result.JWT_EXPIRES_IN).toBe("1d");
			expect(result.PORT).toBe(3000);
			expect(result.MAX_UPLOAD_SIZE_MB).toBe(10);
			expect(result.STORAGE_PROVIDER).toBe("local");
			expect(result.STORAGE_LOCAL_DIR).toBe("./storage/uploads");
			expect(result.RATE_LIMIT_MAX).toBe(100);
			expect(result.AUTH_RATE_LIMIT).toBe(10);
		});

		test("an explicit value overrides the default", () => {
			const result = envSchema.parse({ ...valid, PORT: "8080" });

			expect(result.PORT).toBe(8080);
		});
	});

	describe("numeric bounds", () => {
		for (const [label, overrides] of [
			["a zero port", { PORT: 0 }],
			["a port above 65535", { PORT: 70000 }],
			["a fractional port", { PORT: 3000.5 }],
			["a non numeric port", { PORT: "http" }],
			["a zero upload limit", { MAX_UPLOAD_SIZE_MB: 0 }],
			["a zero rate limit", { RATE_LIMIT_MAX: 0 }],
			["a zero auth rate limit", { AUTH_RATE_LIMIT: 0 }],
			["a zero rate window", { RATE_LIMIT_WINDOW_SECONDS: 0 }],
		] as const) {
			test(`${label} is refused`, () => {
				expect(issuesFor(overrides).length).toBeGreaterThan(0);
			});
		}
	});

	describe("production only rules", () => {
		const production = {
			NODE_ENV: "production",
			FRONTEND_URL: "https://app.example.com",
		} as const;

		test("a production environment with a long secret and an origin is accepted", () => {
			expect(issuesFor(production)).toEqual([]);
		});

		test("a short signing secret is refused in production", () => {
			const found = issuesFor({ ...production, JWT_SECRET: "short" });

			expect(found.some((issue) => issue.path === "JWT_SECRET")).toBe(true);
		});

		test("a secret of exactly 32 characters is accepted", () => {
			expect(issuesFor({ ...production, JWT_SECRET: "x".repeat(32) })).toEqual(
				[],
			);
		});

		// Outside production a short secret is tolerated so a developer is not
		// forced to invent one. That tolerance must not follow a deployment.
		test("a short secret is tolerated outside production", () => {
			expect(issuesFor({ JWT_SECRET: "short" })).toEqual([]);
		});

		test("no configured frontend origin is refused in production", () => {
			const found = issuesFor({ NODE_ENV: "production" });

			expect(found.some((issue) => issue.path === "FRONTEND_URL")).toBe(true);
		});

		test("an empty frontend url counts as absent in production", () => {
			const found = issuesFor({
				NODE_ENV: "production",
				FRONTEND_URL: "   ",
			});

			expect(found.length).toBeGreaterThan(0);
		});

		test("a cors origin alone satisfies the requirement", () => {
			expect(
				issuesFor({
					NODE_ENV: "production",
					CORS_ORIGIN: "https://app.example.com",
				}),
			).toEqual([]);
		});

		test("a comma separated list of origins is accepted", () => {
			expect(
				issuesFor({
					...production,
					FRONTEND_URL: "https://a.example.com, https://b.example.com",
				}),
			).toEqual([]);
		});
	});

	test("every issue is reported, not just the first", () => {
		const found = issuesFor({
			PORT: 0,
			RATE_LIMIT_MAX: -1,
			AUTH_RATE_LIMIT: 0,
		});

		expect(found.length).toBeGreaterThanOrEqual(3);
	});
});
