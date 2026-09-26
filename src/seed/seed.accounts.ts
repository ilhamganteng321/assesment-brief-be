// ---------------------------------------------------------------------------
// The demo accounts the seed creates.
//
// Kept apart from `seed.ts` so that the seed, the login verification and the
// README cannot drift apart. A reviewer is told to sign in with a specific
// address and password; if those lived only inside the seed script there would
// be nothing to check that claim against.
//
// `/auth/register` only ever issues INTERNAL accounts, so the PM and the client
// guest have to be written directly. These are assessment fixtures with no
// real-world value: the password is a published constant, not a secret.
// ---------------------------------------------------------------------------

export const DEFAULT_DEMO_PASSWORD = "DemoPass#2026";

export type SeedAccount = {
	readonly name: string;
	readonly email: string;
	readonly password: string;
	readonly role: "PM" | "INTERNAL" | "CLIENT";
	readonly department: "PRODUCT" | "UI_UX" | "FRONTEND" | "BACKEND" | "CLIENT";
};

/**
 * One account per role the assessment cares about: the product manager who owns
 * the project, three internal team members across different departments so
 * assignment rules have somewhere to bite, and the client guest who must only
 * ever see client-visible work.
 */
export const SEED_ACCOUNTS: readonly SeedAccount[] = [
	{
		name: "Priya Sharma",
		email: "pm@aurora.demo",
		password: DEFAULT_DEMO_PASSWORD,
		role: "PM",
		department: "PRODUCT",
	},
	{
		name: "Leo Nguyen",
		email: "uiux@aurora.demo",
		password: DEFAULT_DEMO_PASSWORD,
		role: "INTERNAL",
		department: "UI_UX",
	},
	{
		name: "Maya Chen",
		email: "frontend@aurora.demo",
		password: DEFAULT_DEMO_PASSWORD,
		role: "INTERNAL",
		department: "FRONTEND",
	},
	{
		name: "Tomas Oliveira",
		email: "backend@aurora.demo",
		password: DEFAULT_DEMO_PASSWORD,
		role: "INTERNAL",
		department: "BACKEND",
	},
	{
		name: "Grace Kim",
		email: "client@aurora.demo",
		password: DEFAULT_DEMO_PASSWORD,
		role: "CLIENT",
		department: "CLIENT",
	},
] as const;

/**
 * The same accounts with the PM's credentials replaced.
 *
 * `bun run seed <email> <password>` provisions the PM as a reviewer's own login;
 * the rest of the demo keeps its published addresses.
 */
export function withPmCredentials(
	email: string | undefined,
	password: string | undefined,
): SeedAccount[] {
	if (email === undefined && password === undefined) {
		return [...SEED_ACCOUNTS];
	}

	const pm = SEED_ACCOUNTS[0];
	if (pm === undefined) {
		throw new Error("seed accounts must include the PM");
	}

	return [
		{
			...pm,
			email: email ?? pm.email,
			password: password ?? pm.password,
		},
		...SEED_ACCOUNTS.slice(1),
	];
}
