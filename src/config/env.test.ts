import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

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

/** The input behind each label in the origin-format cases below. */
const ORIGIN_CASES = {
	"a bare origin": "https://app.example.com",
	"a trailing slash": "https://app.example.com/",
	"surrounding whitespace": "  https://app.example.com  ",
	"an explicit default port": "https://app.example.com:443",
	"an uppercase host": "https://APP.example.com",
	"a missing scheme": "app.example.com",
	"a path": "https://app.example.com/dashboard",
	"a query string": "https://app.example.com?a=1",
	"a fragment": "https://app.example.com#x",
	"embedded credentials": "https://user:pass@app.example.com",
	"a non-http scheme": "ftp://app.example.com",
} as const;

const valueFor = (label: keyof typeof ORIGIN_CASES): string =>
	ORIGIN_CASES[label];

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

	// A malformed origin produces no CORS header at all, so the deployed
	// frontend is refused by every request while the symptom points at the
	// browser. Catching it at boot is the difference between a five-second fix
	// and an afternoon.
	describe("origin format", () => {
		const base = {
			NODE_ENV: "production",
			JWT_SECRET: "x".repeat(32),
		} as const;

		for (const label of [
			"a bare origin",
			"a trailing slash",
			"surrounding whitespace",
			"an explicit default port",
			"an uppercase host",
		] as const) {
			test(`${label} is accepted`, () => {
				expect(issuesFor({ ...base, FRONTEND_URL: valueFor(label) })).toEqual(
					[],
				);
			});
		}

		for (const label of [
			"a missing scheme",
			"a path",
			"a query string",
			"a fragment",
			"embedded credentials",
			"a non-http scheme",
		] as const) {
			test(`${label} is refused`, () => {
				const found = issuesFor({ ...base, FRONTEND_URL: valueFor(label) });

				expect(found.some((issue) => issue.path === "FRONTEND_URL")).toBe(true);
			});
		}

		// The same rule guards CORS_ORIGIN, which is the alias most deployments
		// reach for when FRONTEND_URL is already taken.
		test("a malformed CORS_ORIGIN is refused", () => {
			const found = issuesFor({ ...base, CORS_ORIGIN: "app.example.com" });

			expect(found.some((issue) => issue.path === "CORS_ORIGIN")).toBe(true);
		});

		// One bad entry in a list must not be allowed through by its good
		// neighbours, and the message has to name the value that is wrong.
		test("a bad entry in a list is refused and quoted back", () => {
			const found = issuesFor({
				...base,
				FRONTEND_URL: "https://good.example.com, not-a-url",
			});

			expect(found.some((issue) => issue.path === "FRONTEND_URL")).toBe(true);
			expect(found.some((issue) => issue.message.includes("not-a-url"))).toBe(
				true,
			);
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

// ---------------------------------------------------------------------------
// The two CORS variables are aliases, and that is the part people get wrong when
// filling in a deployment: only one of them is needed, and setting the other to
// an empty string is not the way to say "unused".
//
// An empty string is present-but-unusable, so it is rejected rather than
// treated as absent. The alternative — quietly reading it as "not set" — is
// how an operator ends up disabling CORS by accident and finding out from a
// browser instead of from the service.
// ---------------------------------------------------------------------------
describe("environment schema: the CORS alias pair", () => {
	const production = {
		DATABASE_URL: "postgresql://user:password@localhost:5432/app",
		JWT_SECRET: "x".repeat(32),
		NODE_ENV: "production",
	} as const;

	const issuesForProduction = (
		overrides: Record<string, unknown>,
	): readonly { path: string; message: string }[] => {
		const result = envSchema.safeParse({ ...production, ...overrides });
		return result.success
			? []
			: result.error.issues.map((issue) => ({
					path: issue.path.join("."),
					message: issue.message,
				}));
	};

	test("FRONTEND_URL alone is enough", () => {
		expect(
			issuesForProduction({ FRONTEND_URL: "https://app.example.com" }),
		).toEqual([]);
	});

	test("CORS_ORIGIN alone is enough", () => {
		expect(
			issuesForProduction({ CORS_ORIGIN: "https://app.example.com" }),
		).toEqual([]);
	});

	// The one to guard: a reviewer copying .env.example verbatim should not be
	// stopped by an empty optional variable they were meant to leave alone.
	test("an empty CORS_ORIGIN is refused even when FRONTEND_URL is set", () => {
		const found = issuesForProduction({
			FRONTEND_URL: "https://app.example.com",
			CORS_ORIGIN: "",
		});

		expect(found.some((issue) => issue.path === "CORS_ORIGIN")).toBe(true);
	});

	test("a whitespace-only CORS_ORIGIN is refused", () => {
		const found = issuesForProduction({ CORS_ORIGIN: "   " });

		expect(found.some((issue) => issue.path === "CORS_ORIGIN")).toBe(true);
	});

	test("omitting both is refused in production but fine in development", () => {
		expect(
			issuesForProduction({}).some((issue) => issue.path === "FRONTEND_URL"),
		).toBe(true);
		expect(issuesFor({ NODE_ENV: "development" })).toEqual([]);
	});
});

describe(".env.example", () => {
	const example = readFileSync(
		join(import.meta.dir, "..", "..", ".env.example"),
		"utf8",
	);

	// Anything set to "" reads as a deliberate "this is off" to a human, so the
	// variable is present rather than absent, and the schema rejects it. The
	// example file is the first thing a reviewer copies, so a placeholder in it
	// is a boot failure waiting to happen.
	test("no variable is set to an empty string", () => {
		const empty = example
			.split("\n")
			.map((line) => line.trim())
			.filter((line) => /^[A-Z0-9_]+=""$/.test(line));

		expect(empty).toEqual([]);
	});

	test("it carries placeholders rather than plausible secrets", () => {
		expect(example).toContain("JWT_SECRET=");
		expect(example).toContain("DATABASE_URL=");
		expect(example).not.toMatch(/eyJ[A-Za-z0-9_-]{10,}/);
	});
});
