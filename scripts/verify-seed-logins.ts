import { app } from "../src/app";
import { DEFAULT_DEMO_PASSWORD, SEED_ACCOUNTS } from "../src/seed/seed.accounts";

// ---------------------------------------------------------------------------
// Proves the seeded demo accounts can actually sign in.
//
// The point of seeding is that a reviewer can log in and be shown working
// data, so a schema that migrates cleanly and a seed that reports success are
// not on their own proof of that. This boots the real application against
// whatever DATABASE_URL points at and posts the real login request for every
// documented account, checking both the status and the role that comes back.
//
// Run by `bun run verify:clean-database` against the freshly migrated scratch
// database, and useful on its own against an existing one:
//
//   bun run verify:seed-logins
//
// Exits non-zero if any account fails, so it can gate a deployment.
// ---------------------------------------------------------------------------

type SeedAccount = {
	readonly name: string;
	readonly email: string;
	readonly password: string;
	readonly role: "PM" | "INTERNAL" | "CLIENT";
};

const failures: string[] = [];

console.log("[seed-logins] signing in as every documented demo account\n");

for (const account of SEED_ACCOUNTS) {
	const response = await app.request("/auth/login", {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({
			email: account.email,
			password: account.password,
		}),
	});

	const body = (await response.json()) as {
		data?: { accessToken?: string; user?: { role?: string } };
		error?: { code?: string; message?: string };
	};
	const role = body.data?.user?.role;
	const hasToken = typeof body.data?.accessToken === "string";

	if (response.status !== 200 || !hasToken) {
		failures.push(
			`${account.email}: expected 200 with a token, got ${response.status} ` +
				`(${body.error?.code ?? "no code"}: ${body.error?.message ?? "no message"})`,
		);
		console.log(`  FAIL  ${account.email.padEnd(24)} ${response.status}`);
		continue;
	}

	if (role !== account.role) {
		failures.push(`${account.email}: expected role ${account.role}, got ${role}`);
		console.log(`  FAIL  ${account.email.padEnd(24)} role ${String(role)}`);
		continue;
	}

	console.log(
		`  ok    ${account.email.padEnd(24)} ${String(role).padEnd(9)} ${account.name}`,
	);
}

// A token that is issued but does not work would make the demo look broken in
// the browser, so the strongest check is a protected request with it.
console.log("");
console.log("[seed-logins] using each token on a protected endpoint\n");

for (const account of SEED_ACCOUNTS) {
	const login = await app.request("/auth/login", {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({
			email: account.email,
			password: account.password,
		}),
	});
	const body = (await login.json()) as { data?: { accessToken?: string } };
	const token = body.data?.accessToken;
	if (typeof token !== "string") {
		failures.push(`${account.email}: could not re-obtain a token for the check`);
		continue;
	}

	const me = await app.request("/auth/me", {
		headers: { authorization: `Bearer ${token}` },
	});

	if (me.status !== 200) {
		failures.push(
			`${account.email}: /auth/me with a fresh token returned ${me.status}`,
		);
		console.log(`  FAIL  ${account.email.padEnd(24)} GET /auth/me -> ${me.status}`);
		continue;
	}

	console.log(`  ok    ${account.email.padEnd(24)} GET /auth/me -> 200`);
}

if (failures.length > 0) {
	console.error("\n[seed-logins] FAILED");
	for (const failure of failures) {
		console.error(`  - ${failure}`);
	}
	console.error(
		"\nHas the seed been run against this database? `bun run seed` populates it.",
	);
	process.exit(1);
}

console.log(
	`\n[seed-logins] OK: all ${SEED_ACCOUNTS.length} demo accounts signed in with the documented password`,
);
console.log(`[seed-logins] password: ${DEFAULT_DEMO_PASSWORD}`);
process.exit(0);
