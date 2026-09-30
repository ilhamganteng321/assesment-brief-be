import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import {
	api,
	assertSuiteIsRunnable,
	buildWorld,
	cleanupFixtures,
	databaseIsReachable,
	errorCode,
	jsonPath,
	type World,
} from "../helpers/harness";

// ---------------------------------------------------------------------------
// The team directory, exercised through the HTTP surface.
//
// The directory is the broadest read in the application: it names every account
// in the organisation, so the assertions that matter most are the refusals. A
// suite that only checked that a project manager sees rows would pass just as
// happily against an endpoint that leaked the credential hash and answered a
// client guest.
//
// The client-isolation cases are therefore listed first, and "cannot" is asserted
// as a refusal *and* as proof that nothing came back.
// ---------------------------------------------------------------------------

let reachable = false;
let world: World;

beforeAll(async () => {
	reachable = await databaseIsReachable();
	if (!reachable) {
		return;
	}
	world = await buildWorld();
});

afterAll(cleanupFixtures);

type DirectoryRow = Record<string, unknown>;

async function listUsers(
	actor: { token: string },
	query = "",
): Promise<{ status: number; json: unknown; text: string }> {
	const res = await api(`/users${query}`, { token: actor.token });
	return { status: res.status, json: res.json, text: res.text };
}

function rowsOf(result: { json: unknown }): DirectoryRow[] {
	return jsonPath<DirectoryRow[]>(result as never, ["data", "users"]) ?? [];
}

function paginationOf(result: { json: unknown }): {
	total: number;
	page: number;
	limit: number;
	totalPages: number;
} {
	return (
		jsonPath<{
			total: number;
			page: number;
			limit: number;
			totalPages: number;
		}>(result as never, ["data", "pagination"]) ?? {
			total: -1,
			page: -1,
			limit: -1,
			totalPages: -1,
		}
	);
}

describe("team directory", () => {
	test("the suite is skipped loudly rather than passing on an empty database", () => {
		assertSuiteIsRunnable(reachable);
	});

	describe("client isolation", () => {
		// The narrowest and most important rule in the feature: a client must not
		// be able to enumerate the internal team. Checked first so a failure here
		// is the first thing read, not the last.
		test("a client guest cannot list the directory", async () => {
			const result = await listUsers(world.client);

			expect(result.status).toBe(403);
			expect(errorCode(result as never)).toBe("USER_DIRECTORY_ACCESS_DENIED");
		});

		test("a client guest sees no account data at all, not even their own", async () => {
			const result = await listUsers(world.client, "?rows=100");

			expect(result.status).toBe(403);
			expect(result.text).not.toContain("@example.local");
			expect(result.text).not.toContain("@aurora");
			expect(result.text).not.toContain("aurora.demo");
		});

		// A 403 on the list is not enough on its own: the detail route is a
		// separate handler and has to be refused separately.
		test("a client guest cannot read another user's profile", async () => {
			const res = await api(`/users/${world.engineer.userId}`, {
				token: world.client.token,
			});

			expect(res.status).toBe(403);
			expect(res.text).not.toContain("@example.local");
		});

		test("a client guest cannot read a nonexistent user's profile either", async () => {
			const res = await api("/users/3c9a1e8a-6d5b-4f21-9c3f-8f0d1a2b3c4d", {
				token: world.client.token,
			});

			// Refused before the lookup, so the endpoint cannot be used to probe
			// which accounts exist.
			expect(res.status).toBe(403);
		});

		test("a client cannot use a project id to reach the directory", async () => {
			const res = await api(
				`/users?filters=${encodeURIComponent(JSON.stringify({ id: world.client.userId }))}`,
				{ token: world.client.token },
			);

			expect(res.status).toBe(403);
		});

		test("the directory requires authentication", async () => {
			const res = await api("/users");

			expect(res.status).toBe(401);
		});
	});

	describe("internal users", () => {
		// An internal user is a team member, not an administrator of the org chart.
		// They can see the members of their own projects, which is the subset of
		// the directory their work actually touches.
		test("an internal user cannot list the directory", async () => {
			const result = await listUsers(world.engineer);

			expect(result.status).toBe(403);
			expect(result.text).not.toContain("@example.local");
		});

		test("an internal user cannot read a profile", async () => {
			const res = await api(`/users/${world.otherEngineer.userId}`, {
				token: world.engineer.token,
			});

			expect(res.status).toBe(403);
		});
	});

	describe("project manager access", () => {
		test("a PM can list users", async () => {
			const result = await listUsers(world.pm);

			expect(result.status).toBe(200);
			expect(rowsOf(result).length).toBeGreaterThan(0);
		});

		test("the response carries the pagination envelope", async () => {
			const result = await listUsers(world.pm);
			const pagination = paginationOf(result);

			expect(pagination.page).toBe(1);
			expect(pagination.limit).toBe(20);
			expect(pagination.total).toBeGreaterThan(0);
			expect(pagination.totalPages).toBe(
				Math.ceil(pagination.total / pagination.limit),
			);
		});

		test("every row carries the safe user fields and nothing else", async () => {
			const result = await listUsers(world.pm, "?rows=100");

			expect(rowsOf(result).length).toBeGreaterThan(0);
			for (const row of rowsOf(result)) {
				expect(typeof row.id).toBe("string");
				expect(String(row.id).length).toBeGreaterThan(0);
				expect(String(row.name).length).toBeGreaterThan(0);
				expect(String(row.email).length).toBeGreaterThan(0);
				expect(USER_ROLES as readonly string[]).toContain(row.role as string);
				expect(USER_DEPARTMENTS as readonly string[]).toContain(
					row.department as string,
				);
				expect(Number.isNaN(new Date(String(row.createdAt)).getTime())).toBe(
					false,
				);
			}
		});

		// The single most important assertion in this suite.
		test("passwordHash is never returned", async () => {
			const result = await listUsers(world.pm, "?rows=100");

			expect(result.text).not.toContain("passwordHash");
			expect(result.text).not.toContain("password_hash");
			for (const row of rowsOf(result)) {
				expect(Object.keys(row).sort()).toEqual([
					"createdAt",
					"department",
					"email",
					"id",
					"name",
					"role",
				]);
			}
		});

		test("no authentication secret reaches the response", async () => {
			const result = await listUsers(world.pm, "?rows=100");
			const forbidden = [
				"password",
				"token",
				"secret",
				"hash",
				"jwt",
				"bcrypt",
			];

			for (const needle of forbidden) {
				expect(result.text.toLowerCase()).not.toContain(needle);
			}
		});
	});

	describe("search", () => {
		test("searching by name finds the user", async () => {
			const result = await listUsers(
				world.pm,
				`?searchFilters=${encodeURIComponent(JSON.stringify({ name: "Engineer" }))}`,
			);

			expect(result.status).toBe(200);
			const rows = rowsOf(result);
			expect(rows.length).toBeGreaterThan(0);
			for (const row of rows) {
				expect(
					`${String(row.name)} ${String(row.email)}`
						.toLowerCase()
						.includes("engineer"),
				).toBe(true);
			}
		});

		// A name search also covers the address, because people are looked up by
		// whichever of the two they remember.
		test("a name search also matches an email", async () => {
			const result = await listUsers(
				world.pm,
				`?searchFilters=${encodeURIComponent(JSON.stringify({ name: "eng2" }))}`,
			);

			const rows = rowsOf(result);
			expect(rows.map((row) => row.id)).toContain(world.otherEngineer.userId);
		});

		test("an email search matches the address alone", async () => {
			const result = await listUsers(
				world.pm,
				`?searchFilters=${encodeURIComponent(JSON.stringify({ email: world.otherEngineer.email }))}`,
			);

			expect(result.status).toBe(200);
			expect(rowsOf(result).map((row) => row.id)).toEqual([
				world.otherEngineer.userId,
			]);
		});

		test("search is case-insensitive", async () => {
			const upper = await listUsers(
				world.pm,
				`?searchFilters=${encodeURIComponent(JSON.stringify({ name: "ENGINEER" }))}`,
			);
			const lower = await listUsers(
				world.pm,
				`?searchFilters=${encodeURIComponent(JSON.stringify({ name: "engineer" }))}`,
			);

			expect(paginationOf(upper).total).toBe(paginationOf(lower).total);
			expect(paginationOf(upper).total).toBeGreaterThan(0);
		});

		test("a search matching nobody returns an empty page, not an error", async () => {
			const result = await listUsers(
				world.pm,
				`?searchFilters=${encodeURIComponent(JSON.stringify({ name: "zzz-nobody-zzz" }))}`,
			);

			expect(result.status).toBe(200);
			expect(rowsOf(result)).toEqual([]);
			expect(paginationOf(result).total).toBe(0);
		});

		// A wildcard typed into a search box must be matched as the character it
		// looks like, not widen the match to the whole table.
		test("wildcards in a search are matched literally", async () => {
			const all = await listUsers(world.pm, "?rows=100");
			const literal = await listUsers(
				world.pm,
				`?searchFilters=${encodeURIComponent(JSON.stringify({ name: "%%%" }))}`,
			);

			expect(rowsOf(literal)).toEqual([]);
			expect(paginationOf(literal).total).toBeLessThan(paginationOf(all).total);
		});
	});

	describe("filters", () => {
		test("the role filter narrows the result", async () => {
			const result = await listUsers(
				world.pm,
				`?rows=100&filters=${encodeURIComponent(JSON.stringify({ role: "INTERNAL" }))}`,
			);

			expect(result.status).toBe(200);
			const rows = rowsOf(result);
			expect(rows.length).toBeGreaterThan(0);
			expect(rows.every((row) => row.role === "INTERNAL")).toBe(true);
			expect(rows.map((row) => row.id)).toContain(world.engineer.userId);
			expect(rows.map((row) => row.id)).not.toContain(world.client.userId);
		});

		test("the department filter narrows the result", async () => {
			const result = await listUsers(
				world.pm,
				`?rows=100&filters=${encodeURIComponent(JSON.stringify({ department: "FRONTEND" }))}`,
			);

			const rows = rowsOf(result);
			expect(rows.length).toBeGreaterThan(0);
			expect(rows.every((row) => row.department === "FRONTEND")).toBe(true);
		});

		// The shared list contract accepts arrays, so "PM or INTERNAL" is one
		// request rather than two.
		test("a role filter accepts several values", async () => {
			const result = await listUsers(
				world.pm,
				`?rows=100&filters=${encodeURIComponent(JSON.stringify({ role: ["PM", "INTERNAL"] }))}`,
			);

			const rows = rowsOf(result);
			expect(rows.length).toBeGreaterThan(0);
			expect(
				rows.every((row) => row.role === "PM" || row.role === "INTERNAL"),
			).toBe(true);
			expect(rows.map((row) => row.id)).not.toContain(world.client.userId);
		});

		test("filters combine, and each one narrows", async () => {
			const result = await listUsers(
				world.pm,
				`?rows=100&filters=${encodeURIComponent(
					JSON.stringify({ role: "INTERNAL", department: "FRONTEND" }),
				)}`,
			);

			const rows = rowsOf(result);
			expect(
				rows.every(
					(row) => row.role === "INTERNAL" && row.department === "FRONTEND",
				),
			).toBe(true);
		});

		test("filters combine with a search", async () => {
			const result = await listUsers(
				world.pm,
				`?rows=100&filters=${encodeURIComponent(JSON.stringify({ role: "INTERNAL" }))}&searchFilters=${encodeURIComponent(JSON.stringify({ name: "engineer" }))}`,
			);

			const rows = rowsOf(result);
			expect(rows.length).toBeGreaterThan(0);
			for (const row of rows) {
				expect(row.role).toBe("INTERNAL");
				expect(String(row.name).toLowerCase()).toContain("engineer");
			}
		});

		test("filtering by id returns exactly that user", async () => {
			const result = await listUsers(
				world.pm,
				`?filters=${encodeURIComponent(JSON.stringify({ id: world.pm.userId }))}`,
			);

			expect(rowsOf(result).map((row) => row.id)).toEqual([world.pm.userId]);
		});

		test("an unknown role is rejected", async () => {
			const res = await api(
				`/users?filters=${encodeURIComponent(JSON.stringify({ role: "SUPERUSER" }))}`,
				{ token: world.pm.token },
			);

			expect(res.status).toBe(400);
		});

		test("an unknown department is rejected", async () => {
			const res = await api(
				`/users?filters=${encodeURIComponent(JSON.stringify({ department: "MARKETING" }))}`,
				{ token: world.pm.token },
			);

			expect(res.status).toBe(400);
		});

		// The allow-list is the boundary: an unlisted field is refused outright
		// rather than dropped, so a caller is told rather than left believing it
		// took effect.
		test("a filter field outside the allow-list is rejected", async () => {
			for (const filters of [
				{ passwordHash: "x" },
				{ updatedAt: "2026-01-01" },
				{ projectMembers: [] },
			]) {
				const res = await api(
					`/users?filters=${encodeURIComponent(JSON.stringify(filters))}`,
					{ token: world.pm.token },
				);
				expect(res.status).toBe(400);
			}
		});

		test("a search field outside the allow-list is rejected", async () => {
			const res = await api(
				`/users?searchFilters=${encodeURIComponent(JSON.stringify({ passwordHash: "x" }))}`,
				{ token: world.pm.token },
			);

			expect(res.status).toBe(400);
		});
	});

	describe("sorting", () => {
		const readPage = async (
			query: string,
		): Promise<{ names: string[]; total: number }> => {
			const res = await listUsers(world.pm, `?rows=100${query}`);
			return {
				names: rowsOf(res).map((row) => String(row.name)),
				total: jsonPath<number>(res, ["data", "pagination", "total"]) ?? 0,
			};
		};

		const readNames = async (query: string): Promise<string[]> =>
			(await readPage(query)).names;

		test("sorting by name ascending orders the page", async () => {
			const names = await readNames("&orderKey=name&orderRule=asc");

			expect(names.length).toBeGreaterThan(1);
			expect([...names].sort()).toEqual(names);
		});

		test("descending orders the page the other way", async () => {
			const ascending = await readPage("&orderKey=name&orderRule=asc");
			const descending = await readPage("&orderKey=name&orderRule=desc");

			// Each page is ordered the way it asked to be.
			expect([...descending.names].sort().reverse()).toEqual(descending.names);
			// Both are the same query over the same table, so they report the same
			// size — which is what ties the two orderings to one another.
			//
			// The two *pages* are deliberately not compared as reversed copies of each
			// other. That only holds while the whole directory fits in one page: with
			// more accounts than `rows`, the first page ascending and the first page
			// descending are different rows, and an assertion of the form
			// `descending === [...ascending].reverse()` passes only on a table small
			// enough for the truncation to be invisible.
			expect(descending.total).toBe(ascending.total);
			expect(descending.names.length).toBe(ascending.names.length);
			expect(descending.total).toBeGreaterThan(0);
		});

		test("every allow-listed order key works", async () => {
			for (const key of ["name", "email", "role", "department", "createdAt"]) {
				const res = await api(`/users?rows=5&orderKey=${key}`, {
					token: world.pm.token,
				});
				expect(res.status).toBe(200);
			}
		});

		// The order key is a closed set, so nothing from the request can reach the
		// query as a fragment.
		test("an order key outside the allow-list is rejected", async () => {
			for (const key of [
				"passwordHash",
				"id",
				"email;DROP TABLE users",
				"name ",
			]) {
				const res = await api(`/users?orderKey=${encodeURIComponent(key)}`, {
					token: world.pm.token,
				});
				expect(res.status).toBe(400);
			}
		});

		test("an invalid order rule is rejected", async () => {
			const res = await api("/users?orderRule=ascending", {
				token: world.pm.token,
			});

			expect(res.status).toBe(400);
		});
	});

	describe("pagination", () => {
		test("paging returns different rows and a stable total", async () => {
			const first = await listUsers(
				world.pm,
				"?rows=1&page=1&orderKey=name&orderRule=asc",
			);
			const second = await listUsers(
				world.pm,
				"?rows=1&page=2&orderKey=name&orderRule=asc",
			);

			const firstRows = rowsOf(first);
			const secondRows = rowsOf(second);
			expect(firstRows.length).toBe(1);
			expect(secondRows.length).toBe(1);
			expect(firstRows[0]?.id).not.toBe(secondRows[0]?.id);
			expect(paginationOf(first).total).toBe(paginationOf(second).total);
		});

		// Without a stable secondary sort, two people sharing a name could trade
		// places between two requests and one would never be seen.
		test("paging is stable across repeated requests", async () => {
			const ids = async (page: string) =>
				rowsOf(
					await listUsers(
						world.pm,
						`?rows=1&page=${page}&orderKey=name&orderRule=asc`,
					),
				).map((row) => row.id);

			expect(await ids("1")).toEqual(await ids("1"));
			expect(await ids("2")).toEqual(await ids("2"));
		});

		test("a page beyond the end is empty rather than an error", async () => {
			const total = paginationOf(await listUsers(world.pm)).total;
			const result = await listUsers(
				world.pm,
				`?rows=5&page=${String(Math.max(1, total + 1))}`,
			);

			expect(result.status).toBe(200);
			expect(rowsOf(result)).toEqual([]);
		});

		test("the row cap is enforced", async () => {
			const res = await api("/users?rows=500", { token: world.pm.token });

			expect(res.status).toBe(400);
		});

		test("an invalid page is rejected", async () => {
			expect(
				(await api("/users?page=0", { token: world.pm.token })).status,
			).toBe(400);
			expect(
				(await api("/users?page=1.5", { token: world.pm.token })).status,
			).toBe(400);
			expect(
				(await api("/users?rows=0", { token: world.pm.token })).status,
			).toBe(400);
		});
	});

	describe("user detail", () => {
		test("a PM can read a user", async () => {
			const res = await api(`/users/${world.engineer.userId}`, {
				token: world.pm.token,
			});

			expect(res.status).toBe(200);
			expect(jsonPath<string>(res, ["data", "user", "id"])).toBe(
				world.engineer.userId,
			);
			expect(typeof jsonPath<string>(res, ["data", "user", "name"])).toBe(
				"string",
			);
		});

		test("a profile carries the safe fields and nothing else", async () => {
			const res = await api(`/users/${world.engineer.userId}`, {
				token: world.pm.token,
			});

			expect(res.text).not.toContain("passwordHash");
			const user = jsonPath<Record<string, unknown>>(res, ["data", "user"]);
			expect(Object.keys(user ?? {}).sort()).toEqual([
				"createdAt",
				"department",
				"email",
				"id",
				"name",
				"role",
			]);
		});

		test("a PM can read their own profile through the directory", async () => {
			const res = await api(`/users/${world.pm.userId}`, {
				token: world.pm.token,
			});

			expect(res.status).toBe(200);
			expect(jsonPath<string>(res, ["data", "user", "id"])).toBe(
				world.pm.userId,
			);
		});

		test("a PM can read a client account's safe profile", async () => {
			const res = await api(`/users/${world.client.userId}`, {
				token: world.pm.token,
			});

			expect(res.status).toBe(200);
			expect(jsonPath<string>(res, ["data", "user", "role"])).toBe("CLIENT");
		});

		test("a non-existent user is a 404", async () => {
			const res = await api("/users/3c9a1e8a-6d5b-4f21-9c3f-8f0d1a2b3c4d", {
				token: world.pm.token,
			});

			expect(res.status).toBe(404);
			expect(errorCode(res)).toBe("USER_NOT_FOUND");
		});

		test("a malformed id is a validation failure, not a lookup", async () => {
			const res = await api("/users/not-a-uuid", { token: world.pm.token });

			expect(res.status).toBe(400);
		});

		// The directory is for collaboration, not account administration: nothing
		// here changes a user, and the router refuses the verbs outright rather
		// than leaving them to a service that has to remember to.
		test("the directory exposes no write route", async () => {
			for (const method of ["POST", "PATCH", "PUT", "DELETE"]) {
				const res = await api(`/users/${world.engineer.userId}`, {
					method,
					token: world.pm.token,
					body: { role: "PM" },
				});
				expect(res.status).toBe(405);
			}
		});
	});

	describe("the project member candidate search still works", () => {
		// The candidate search was refactored to share the directory's text
		// search. Sharing the query is fine; sharing the *boundary* is not, so
		// these re-pin everything project-specific about it.
		test("a PM can still search candidates on a project", async () => {
			const res = await api(
				`/projects/${world.project.id}/members/candidates?search=Engineer`,
				{ token: world.pm.token },
			);

			expect(res.status).toBe(200);
			const candidates =
				jsonPath<Array<{ id: string; alreadyMember: boolean }>>(res, [
					"data",
					"candidates",
				]) ?? [];
			expect(candidates.length).toBeGreaterThan(0);
			expect(
				candidates.find((candidate) => candidate.id === world.engineer.userId)
					?.alreadyMember,
			).toBe(true);
		});

		test("candidates are still project-scoped, not the global directory", async () => {
			// The client is a member of the primary project and not of the foreign
			// one, so the same person must be reported differently by the same
			// search against each project. That is the property the global directory
			// cannot have, and the one worth pinning.
			// `rows` is raised to the cap because the case is about *scoping*, not
			// paging. The default page is 10, and a seeded directory larger than that
			// pushes the shared world's own client off the first page — which would
			// make this test fail for a reason that has nothing to do with scoping.
			const membershipFor = async (projectId: string) => {
				const res = await api(
					`/projects/${projectId}/members/candidates?search=client&rows=20`,
					{ token: world.pm.token },
				);
				return (
					jsonPath<Array<{ id: string; alreadyMember: boolean }>>(res, [
						"data",
						"candidates",
					]) ?? []
				).find((candidate) => candidate.id === world.client.userId);
			};

			expect((await membershipFor(world.project.id))?.alreadyMember).toBe(true);
			expect(
				(await membershipFor(world.foreignProject.id))?.alreadyMember,
			).toBe(false);
		});

		test("candidate search still refuses an internal user", async () => {
			const res = await api(
				`/projects/${world.project.id}/members/candidates?search=Engineer`,
				{ token: world.engineer.token },
			);

			expect(res.status).toBe(403);
		});

		test("candidate search still refuses a client guest", async () => {
			const res = await api(
				`/projects/${world.project.id}/members/candidates?search=Engineer`,
				{ token: world.client.token },
			);

			expect(res.status).toBe(403);
			expect(res.text).not.toContain("@example.local");
		});

		test("candidate search still excludes the credential hash", async () => {
			const res = await api(
				`/projects/${world.project.id}/members/candidates?search=Engineer`,
				{ token: world.pm.token },
			);

			expect(res.text).not.toContain("passwordHash");
			const candidates =
				jsonPath<Array<Record<string, unknown>>>(res, ["data", "candidates"]) ??
				[];
			for (const candidate of candidates) {
				expect(Object.keys(candidate).sort()).toEqual([
					"alreadyMember",
					"department",
					"email",
					"id",
					"name",
					"role",
				]);
			}
		});

		// The end-to-end reason the directory exists: discover somebody, then put
		// them on a project through the project-scoped route.
		test("a PM can find a colleague in the directory and add them to a project", async () => {
			const [pmEmail, pmName] = [
				"it-directory-pm@example.local",
				"It Directory PM",
			];
			void pmName;
			void pmEmail;

			// The engineer is discoverable in the directory...
			const found = rowsOf(
				await listUsers(
					world.pm,
					`?searchFilters=${encodeURIComponent(JSON.stringify({ name: world.engineer.email }))}`,
				),
			).find((row) => row.id === world.engineer.userId);
			expect(found).toBeDefined();

			// ...is addable on a project they are not yet a member of, and the add
			// is what grants them access.
			const created = await api("/projects", {
				method: "POST",
				token: world.pm.token,
				body: { name: `It Directory walk ${Date.now().toString(36)}` },
			});
			const projectId =
				jsonPath<string>(created, ["data", "project", "id"]) ?? "";
			expect(projectId.length).toBeGreaterThan(0);

			try {
				expect(
					(await api(`/projects/${projectId}`, { token: world.engineer.token }))
						.status,
				).toBe(403);

				const added = await api(`/projects/${projectId}/members`, {
					method: "POST",
					token: world.pm.token,
					body: { userId: world.engineer.userId },
				});
				expect(added.status).toBe(201);

				expect(
					(await api(`/projects/${projectId}`, { token: world.engineer.token }))
						.status,
				).toBe(200);
			} finally {
				await api(`/projects/${projectId}/members/${world.engineer.userId}`, {
					method: "DELETE",
					token: world.pm.token,
				});
				await api(`/projects/${projectId}`, {
					method: "DELETE",
					token: world.pm.token,
				});
			}
		});
	});

	describe("membership access is unchanged by the directory existing", () => {
		// A directory entry is not a membership. Reading the list must not have
		// quietly become another way to see a project's people.
		test("being in the directory does not grant access to a project", async () => {
			const res = await api(`/projects/${world.foreignProject.id}`, {
				token: world.engineer.token,
			});

			expect(res.status).toBe(403);
		});

		test("the directory does not list project members or their projects", async () => {
			const result = await listUsers(world.pm, "?rows=100");

			for (const row of rowsOf(result)) {
				expect(Object.keys(row)).not.toContain("projectMembers");
				expect(Object.keys(row)).not.toContain("projects");
			}
		});
	});
});

const USER_ROLES = ["PM", "INTERNAL", "CLIENT"] as const;
const USER_DEPARTMENTS = [
	"PRODUCT",
	"UI_UX",
	"FRONTEND",
	"BACKEND",
	"CLIENT",
] as const;
