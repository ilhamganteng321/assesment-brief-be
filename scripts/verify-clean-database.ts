import { spawnSync } from "node:child_process";
import { Client } from "pg";

// ---------------------------------------------------------------------------
// Verifies the schema builds from nothing: create an empty database, apply every
// migration in order, seed it, and confirm the seeded accounts can actually log
// in. A reviewer provisioning a fresh database should not hit anything this
// script does not already exercise.
//
// Usage:  bun run verify:clean-database
//
// The scratch database is named with a timestamp and dropped again on the way
// out, including when a step fails, so the source database is never touched.
// ---------------------------------------------------------------------------

const sourceUrl = process.env.DATABASE_URL;
if (!sourceUrl) {
	console.error("[clean-db] DATABASE_URL is not set");
	process.exit(1);
}

const suffix = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
const scratchName = `clean_verify_${suffix}`;

const source = new URL(sourceUrl);
const scratchUrl = new URL(sourceUrl);
scratchUrl.pathname = `/${scratchName}`;

const admin = new Client({
	connectionString: sourceUrl,
	ssl: { rejectUnauthorized: false },
});

let created = false;

function step(label: string, command: string, args: string[], env: NodeJS.ProcessEnv) {
	console.log(`[clean-db] ${label}`);
	const result = spawnSync(command, args, {
		stdio: "inherit",
		env: { ...process.env, ...env },
		shell: false,
	});
	if (result.status !== 0) {
		throw new Error(`${label} failed with exit code ${result.status ?? "signal"}`);
	}
}

async function cleanup() {
	if (!created) {
		return;
	}
	try {
		// Evict other sessions; a pooled connection may still be attached.
		await admin.query(
			`SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1`,
			[scratchName],
		);
		await admin.query(`DROP DATABASE IF EXISTS "${scratchName}"`);
		console.log(`[clean-db] dropped ${scratchName}`);
	} catch (error) {
		console.error(
			`[clean-db] could not drop ${scratchName}: ${(error as Error).message}`,
		);
	}
}

try {
	await admin.connect();

	// Fail early and loudly rather than leaving an orphan database behind.
	await admin.query(`DROP DATABASE IF EXISTS "${scratchName}"`);
	await admin.query(`CREATE DATABASE "${scratchName}"`);
	created = true;
	console.log(`[clean-db] created ${scratchName}`);
	console.log(`[clean-db] applying migrations from scratch`);

	step("migrate", "bunx", ["prisma", "db", "migrate"], {
		DATABASE_URL: scratchUrl.toString(),
	});

	step("seed", "bun", ["run", "src/seed/seed.ts"], {
		DATABASE_URL: scratchUrl.toString(),
	});

	// Boot the real application against the freshly built database and prove the
	// documented demo accounts work, which is the whole point of seeding.
	step("sign in as every seeded demo account", "bun", [
		"run",
		"scripts/verify-seed-logins.ts",
	], {
		DATABASE_URL: scratchUrl.toString(),
	});

	step("typecheck against the fresh schema", "bun", ["run", "typecheck"], {});

	console.log(
		`[clean-db] OK: ${scratchName} was migrated, seeded, signed into and typed against`,
	);
} catch (error) {
	console.error(`[clean-db] FAILED: ${(error as Error).message}`);
	await cleanup();
	process.exit(1);
}

await cleanup();
process.exit(0);
