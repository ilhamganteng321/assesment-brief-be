import { spawnSync } from "node:child_process";
import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";

// ---------------------------------------------------------------------------
// Runs the DB-backed suites under `tests/` one after another.
//
// Sequential on purpose. Each suite drives the same in-process app and the same
// PostgreSQL database, and the application rate limiter is a single in-memory
// store shared by every request, so running suites concurrently would let one
// suite's traffic throttle another's assertions.
//
// The rate limits are raised for the run. `dotenv` never overwrites a variable
// that is already set, so these take precedence over `.env`. The limiter's own
// behaviour is covered by `src/security/security.test.ts`, which builds the
// middleware with an explicit limit and its own store, so nothing is lost.
//
// Usage:  bun run test:suites
// ---------------------------------------------------------------------------

const TESTS_DIR = join(import.meta.dir);
const SUITE_TIMEOUT_MS = 300_000;

function findSuites(directory: string): string[] {
	const found: string[] = [];
	for (const entry of readdirSync(directory)) {
		const path = join(directory, entry);
		if (statSync(path).isDirectory()) {
			if (entry !== "helpers") {
				found.push(...findSuites(path));
			}
		} else if (entry.endsWith(".integration.ts")) {
			found.push(path);
		}
	}
	return found.sort();
}

const suites = findSuites(TESTS_DIR);

if (suites.length === 0) {
	console.error("[suites] no *.integration.ts files found under tests/");
	process.exit(1);
}

const env = {
	...process.env,
	AUTH_RATE_LIMIT: "100000",
	AUTH_RATE_WINDOW_SECONDS: "3600",
	RATE_LIMIT_MAX: "1000000",
	RATE_LIMIT_WINDOW_SECONDS: "3600",
};

/** Forward slashes keep the argument identical on every platform. */
const toPosix = (value: string): string => value.replace(/\\/g, "/");

/** Path as the summary should show it, relative to `tests/`. */
const label = (suite: string): string =>
	toPosix(suite.slice(TESTS_DIR.length + 1));

console.log(`[suites] ${suites.length} suite(s), sequential`);
console.log("[suites] rate limits raised so suite traffic is not throttled\n");

const failed: string[] = [];
const started = Date.now();

for (const suite of suites) {
	const name = label(suite);
	console.log(`[suites] ${name}`);

	const result = spawnSync(
		process.execPath,
		["test", toPosix(suite)],
		{ stdio: "inherit", env, timeout: SUITE_TIMEOUT_MS },
	);

	if (result.error) {
		console.error(`[suites] ${name} could not start: ${result.error.message}`);
		failed.push(name);
	} else if (result.status !== 0) {
		failed.push(name);
	}
	console.log("");
}

const seconds = ((Date.now() - started) / 1000).toFixed(1);
console.log("[suites] summary");
for (const suite of suites) {
	const name = label(suite);
	console.log(`  ${failed.includes(name) ? "FAIL" : "ok  "}  ${name}`);
}
console.log(`\n[suites] ${suites.length - failed.length}/${suites.length} passed in ${seconds}s`);

process.exit(failed.length > 0 ? 1 : 0);
