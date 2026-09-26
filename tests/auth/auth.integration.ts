import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHmac } from "node:crypto";

import { env } from "../../src/config/env";
import { verifyAccessToken } from "../../src/modules/auth/auth.service";
import { db } from "../../src/prisma/db";
import {
	TEST_PASSWORD,
	type Actor,
	api,
	assertSuiteIsRunnable,
	cleanupFixtures,
	createPrivilegedActor,
	databaseIsReachable,
	errorCode,
	errorMessage,
	itEmail,
	jsonPath,
	login,
	registerInternal,
} from "../helpers/harness";

// ---------------------------------------------------------------------------
// Authentication and JWT validation (assessment sections 3 and 34).
//
// The rule under test is simple: the token decides who you are, and nothing
// about the request may change that. Anything the API cannot vouch for is a
// 401, and the 401 must not describe what went wrong.
// ---------------------------------------------------------------------------

let reachable = false;
let internal: Actor;

beforeAll(async () => {
	reachable = await databaseIsReachable();
	if (!reachable) {
		return;
	}
	internal = await registerInternal({
		name: "It Auth Subject",
		email: itEmail("auth"),
		department: "BACKEND",
	});
});

afterAll(cleanupFixtures);

/** Signs a token that is well formed but already past its expiry. */
function expiredToken(userId: string): string {
	// `verifyAccessToken` only accepts HS256 signed with the configured secret, so
	// an expired token has to be minted properly. A token that fails for some
	// other reason would prove nothing about expiry handling.
	const now = Math.floor(Date.now() / 1000);
	const header = base64Url(JSON.stringify({ alg: "HS256", typ: "JWT" }));
	const payload = base64Url(
		JSON.stringify({ sub: userId, iat: now - 7200, exp: now - 3600 }),
	);
	const signingInput = `${header}.${payload}`;
	return `${signingInput}.${hmacSha256Base64Url(signingInput, env.JWT_SECRET)}`;
}

function base64Url(value: string): string {
	return Buffer.from(value, "utf8").toString("base64url");
}

function hmacSha256Base64Url(value: string, secret: string): string {
	return createHmac("sha256", secret).update(value).digest("base64url");
}

describe("authentication", () => {
	test("the suite is skipped loudly rather than passing on an empty database", () => {
		assertSuiteIsRunnable(reachable);
	});

	test("register issues a usable token for the new INTERNAL account", async () => {
		const res = await api("/auth/register", {
			method: "POST",
			body: {
				name: "It Fresh",
				email: itEmail("fresh"),
				password: "AnotherPass#2026",
				department: "FRONTEND",
			},
		});

		expect(res.status).toBe(201);
		expect(jsonPath<string>(res, ["data", "user", "role"])).toBe("INTERNAL");
		expect(typeof jsonPath(res, ["data", "accessToken"])).toBe("string");
		// A password hash must never travel back to the caller.
		expect(res.text).not.toContain("passwordHash");
	});

	test("register cannot be used to mint a PM or a client account", async () => {
		const res = await api("/auth/register", {
			method: "POST",
			body: {
				name: "It Escalation",
				email: itEmail("escalate"),
				password: "AnotherPass#2026",
				role: "PM",
			},
		});

		// `role` is not an accepted key. It used to be dropped silently, which was
		// safe but hid the attempt; the schema is strict now, so the caller is
		// told the field does not exist. Either way the account must not gain a
		// privileged role.
		expect(res.status).toBe(400);
		expect(errorCode(res)).toBe("INVALID_REQUEST");

		// And no account was created under that email.
		const lookup = await api("/auth/login", {
			method: "POST",
			body: { email: itEmail("escalate"), password: "AnotherPass#2026" },
		});
		expect(lookup.status).toBe(401);
	});

	test("a duplicate email is refused with a conflict", async () => {
		const email = itEmail("dupe");
		const first = await api("/auth/register", {
			method: "POST",
			body: { name: "It Dupe", email, password: "AnotherPass#2026" },
		});
		expect(first.status).toBe(201);

		const second = await api("/auth/register", {
			method: "POST",
			body: { name: "It Dupe", email, password: "AnotherPass#2026" },
		});
		expect(second.status).toBe(409);
		expect(errorCode(second)).toBe("EMAIL_ALREADY_REGISTERED");
	});

	test("login returns the account and a token for correct credentials", async () => {
		const res = await api("/auth/login", {
			method: "POST",
			body: { email: internal.email, password: TEST_PASSWORD },
		});

		expect(res.status).toBe(200);
		expect(jsonPath<string>(res, ["data", "user", "email"])).toBe(internal.email);
		expect(typeof jsonPath(res, ["data", "accessToken"])).toBe("string");
	});

	test("login does not reveal whether the email or the password was wrong", async () => {
		const wrongPassword = await api("/auth/login", {
			method: "POST",
			body: { email: internal.email, password: "NotThePassword#1" },
		});
		const unknownEmail = await api("/auth/login", {
			method: "POST",
			body: { email: itEmail("ghost"), password: TEST_PASSWORD },
		});

		expect(wrongPassword.status).toBe(401);
		expect(unknownEmail.status).toBe(401);
		// Identical code and message, so the endpoint cannot be used to
		// enumerate registered addresses.
		expect(errorCode(wrongPassword)).toBe("INVALID_CREDENTIALS");
		expect(errorCode(unknownEmail)).toBe("INVALID_CREDENTIALS");
		expect(errorMessage(wrongPassword)).toBe(errorMessage(unknownEmail));
	});

	test("a valid token lets a protected request through", async () => {
		const res = await api("/auth/me", { token: internal.token });

		expect(res.status).toBe(200);
		expect(jsonPath<string>(res, ["data", "user", "id"])).toBe(internal.userId);
	});

	test("logout succeeds and the session payload never carried a password", async () => {
		const res = await api("/auth/logout", { method: "POST", token: internal.token });

		expect(res.status).toBe(200);
		expect(jsonPath<boolean>(res, ["success"])).toBe(true);
		expect(res.text.toLowerCase()).not.toContain("password");
	});

	describe("token rejection", () => {
		const cases: readonly { label: string; header?: string }[] = [
			{ label: "no Authorization header at all", header: undefined },
			{ label: "an empty Bearer value", header: "Bearer " },
			{ label: "a scheme other than Bearer", header: "Basic abc123" },
			{ label: "a token that is not a JWT", header: "Bearer not-a-jwt" },
			{ label: "a token signed with the wrong secret", header: "Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjMifQ.invalidsignature" },
			{ label: "a structurally broken token", header: "Bearer a.b" },
		];

		for (const { label, header } of cases) {
			test(`${label} is rejected with 401`, async () => {
				const res = await api("/auth/me", {
					headers: header ? { Authorization: header } : {},
				});

				expect(res.status).toBe(401);
				expect(errorCode(res)).toBe("UNAUTHORIZED");
			});
		}

		test("an expired token is rejected", () => {
			expect(() => verifyAccessToken(expiredToken(internal.userId))).toThrow();
		});

		test("a valid token resolves to the subject it names", () => {
			expect(verifyAccessToken(internal.token)).toBe(internal.userId);
		});
	});

	describe("the token is the only source of identity", () => {
		test("a body userId cannot override the authenticated actor", async () => {
			const pm = await createPrivilegedActor({
				role: "PM",
				email: itEmail("auth-pm"),
				department: "PRODUCT",
			});
			const victim = await registerInternal({
				name: "It Victim",
				email: itEmail("victim"),
				department: "BACKEND",
			});

			const res = await api("/auth/register", {
				method: "POST",
				token: internal.token,
				body: {
					name: "It Impostor",
					email: itEmail("impostor"),
					password: "AnotherPass#2026",
					userId: victim.userId,
					createdBy: pm.userId,
				},
			});

			// Whatever the outcome, the account that ends up existing must not
			// carry the submitted identity.
			if (res.status === 201) {
				const created = jsonPath<string>(res, ["data", "user", "id"]);
				expect(created).not.toBe(victim.userId);
				expect(created).not.toBe(pm.userId);
			} else {
				expect(res.status).toBe(400);
			}
		});

		test("a token for a deleted account stops working", async () => {
			const throwaway = await createPrivilegedActor({
				role: "PM",
				email: itEmail("doomed"),
				department: "PRODUCT",
			});
			expect((await api("/auth/me", { token: throwaway.token })).status).toBe(200);

			await db.orm.public.Users.where((u) => u.id.eq(throwaway.userId)).delete();

			const res = await api("/auth/me", { token: throwaway.token });
			expect(res.status).toBe(401);
			expect(errorCode(res)).toBe("UNAUTHORIZED");
		});
	});

	describe("error responses stay safe", () => {
		test("a failed request never carries a stack, SQL or driver detail", async () => {
			const responses = await Promise.all([
				api("/auth/me"),
				api("/auth/me", { token: "Bearer garbage" }),
				api("/auth/login", {
					method: "POST",
					body: { email: internal.email, password: "wrong" },
				}),
				api("/auth/register", { method: "POST", body: { email: "nope" } }),
				api("/auth/login", { method: "POST", rawBody: "{not json" }),
			]);

			for (const res of responses) {
				expect(res.status).toBeGreaterThanOrEqual(400);
				const body = res.text.toLowerCase();
				for (const leak of [
					"stack",
					"at async",
					".ts:",
					"select ",
					"insert into",
					"password_hash",
					"postgres://",
					"postgresql://",
				]) {
					expect(body).not.toContain(leak);
				}
			}
		});

		test("every error response uses the one envelope", async () => {
			const res = await api("/auth/me");

			expect(res.status).toBe(401);
			expect(jsonPath<boolean>(res, ["success"])).toBe(false);
			expect(typeof jsonPath(res, ["error", "code"])).toBe("string");
			expect(typeof jsonPath(res, ["error", "message"])).toBe("string");
			expect(typeof jsonPath(res, ["error", "requestId"])).toBe("string");
		});

		test("a malformed JSON body is a validation error, not a crash", async () => {
			const res = await api("/auth/login", {
				method: "POST",
				rawBody: "{ this is not json",
			});

			expect(res.status).toBe(400);
			expect(errorCode(res)).toBe("INVALID_REQUEST");
		});
	});

	describe("login helper sanity", () => {
		test("a wrong password yields no token", async () => {
			const token = await login(internal.email, "Definitely#Wrong1");
			expect(token).toBe("");
		});
	});
});
