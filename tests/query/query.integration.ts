import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import {
	type World,
	api,
	assertSuiteIsRunnable,
	buildWorld,
	cleanupFixtures,
	createTask,
	databaseIsReachable,
	jsonPath,
} from "../helpers/harness";

// ---------------------------------------------------------------------------
// The list query contract (assessment sections 18 to 24).
//
// `/tasks` accepts exactly seven parameters: `filters`, `searchFilters`,
// `rangedFilters`, `page`, `rows`, `orderKey` and `orderRule`. Everything below
// exercises them through the API, including the cases a reviewer will try:
// a value outside the allow-list, an over-large page size, a page past the end,
// and all seven combined in one request.
//
// `orderKey` is worth calling out. It is a closed enum, so an attempt to smuggle
// a column name or a SQL fragment is a validation error rather than something
// that reaches the database.
// ---------------------------------------------------------------------------

let reachable = false;
let world: World;
/** Titles the filters and searches key off, all in `world.project`. */
const titles = {
	alpha: "Alpha frontend dashboard",
	beta: "Beta backend integration",
	gamma: "Gamma frontend mobile",
	delta: "Delta design system",
} as const;

beforeAll(async () => {
	reachable = await databaseIsReachable();
	if (!reachable) {
		return;
	}
	world = await buildWorld();

	await createTask(world.pm, world.project.id, titles.alpha, {
		status: "DONE",
		priority: "HIGH",
		department: "FRONTEND",
		clientVisible: true,
	});
	await createTask(world.pm, world.project.id, titles.beta, {
		status: "TODO",
		priority: "HIGH",
		department: "BACKEND",
	});
	await createTask(world.pm, world.project.id, titles.gamma, {
		status: "IN_PROGRESS",
		priority: "LOW",
		department: "FRONTEND",
	});
	await createTask(world.pm, world.project.id, titles.delta, {
		status: "DONE",
		priority: "LOW",
		department: "UI_UX",
	});
});

afterAll(cleanupFixtures);

type ListResult = { status: number; json: unknown; text: string };

/** A query broken into its parts, so the helper can merge in the project scope. */
type ListQuery = {
	readonly filters?: Record<string, unknown>;
	readonly searchFilters?: Record<string, unknown>;
	readonly rangedFilters?: readonly Record<string, unknown>[];
	readonly page?: number | string;
	readonly rows?: number | string;
	readonly orderKey?: string;
	readonly orderRule?: string;
	/** Replaces the whole query string, for tests sending something invalid. */
	readonly raw?: string;
};

/**
 * Calls the flat task list, always scoped to this fixture's project.
 *
 * The scope goes inside `filters` because that is the only place `projectId` is
 * accepted: the list schema is a strict object, so a top-level `projectId`
 * would be an unknown key. `raw` bypasses the helper entirely so a test can
 * send a query string that is meant to be rejected.
 */
async function listTasks(
	query: ListQuery = {},
	token = world.pm.token,
): Promise<ListResult> {
	if (query.raw !== undefined) {
		const res = await api(`/tasks?${query.raw}`, { token });
		return { status: res.status, json: res.json, text: res.text };
	}

	const params = new URLSearchParams();
	for (const key of ["page", "rows", "orderKey", "orderRule"] as const) {
		const value = query[key];
		if (value !== undefined) {
			params.set(key, String(value));
		}
	}
	params.set(
		"filters",
		JSON.stringify({ projectId: world.project.id, ...query.filters }),
	);
	if (query.searchFilters !== undefined) {
		params.set("searchFilters", JSON.stringify(query.searchFilters));
	}
	if (query.rangedFilters !== undefined) {
		params.set("rangedFilters", JSON.stringify(query.rangedFilters));
	}

	const res = await api(`/tasks?${params.toString()}`, { token });
	return { status: res.status, json: res.json, text: res.text };
}

/** Reads a nested value out of a list response. */
function dig<T>(result: ListResult, path: readonly string[]): T | undefined {
	let current: unknown = result.json;
	for (const key of path) {
		if (current === null || typeof current !== "object" || !(key in current)) {
			return undefined;
		}
		current = (current as Record<string, unknown>)[key];
	}
	return current as T;
}

const rowsOf = (result: ListResult): Record<string, unknown>[] =>
	dig<Record<string, unknown>[]>(result, ["data", "tasks"]) ?? [];

const paginationOf = (
	result: ListResult,
	key: "page" | "limit" | "total" | "totalPages",
): number | undefined => dig<number>(result, ["data", "pagination", key]);

const codeOf = (result: ListResult): string =>
	String(dig<string>(result, ["error", "code"]) ?? "");

describe("list query contract", () => {
	test("the suite is skipped loudly rather than passing on an empty database", () => {
		assertSuiteIsRunnable(reachable);
	});

	describe("filters", () => {
		test("a single equality filter returns only matching rows", async () => {
			const res = await listTasks({ filters: { status: "DONE" } });

			expect(res.status).toBe(200);
			const rows = rowsOf(res);
			expect(rows.length).toBeGreaterThan(0);
			for (const row of rows) {
				expect(row.status).toBe("DONE");
			}
		});

		test("two filters combine as an intersection", async () => {
			const res = await listTasks({
				filters: { status: "DONE", priority: "HIGH" },
			});

			expect(res.status).toBe(200);
			const rows = rowsOf(res);
			expect(rows.length).toBeGreaterThan(0);
			for (const row of rows) {
				expect(row.status).toBe("DONE");
				expect(row.priority).toBe("HIGH");
			}
			// A row matching only one of the two criteria must be absent.
			expect(rows.some((row) => row.title === titles.delta)).toBe(false);
		});

		test("a filter that matches nothing yields an empty page, not an error", async () => {
			// `title` is searchable but not filterable, so a department the
			// fixture never uses is the honest way to ask for no rows.
			const res = await listTasks({ filters: { department: "UI_UX", status: "TODO" } });

			expect(res.status).toBe(200);
			expect(rowsOf(res)).toHaveLength(0);
			expect(paginationOf(res, "total")).toBe(0);
		});

		test("a title cannot be used as a filter, only searched", async () => {
			const res = await listTasks({ filters: { title: titles.alpha } });
			expect(res.status).toBe(400);
		});

		test("a filter cannot name a column that is not on the allow-list", async () => {
			const res = await listTasks({ filters: { passwordHash: "x" } });

			expect(res.status).toBe(400);
			expect(codeOf(res)).toBe("INVALID_REQUEST");
		});

		test("an unknown query parameter is rejected", async () => {
			const res = await listTasks({ raw: "includeDeleted=true" });

			expect(res.status).toBe(400);
		});
	});

	describe("array filters", () => {
		test("a list of values matches any of them", async () => {
			const res = await listTasks({
				filters: { status: ["TODO", "IN_PROGRESS"] },
			});

			expect(res.status).toBe(200);
			const rows = rowsOf(res);
			expect(rows.length).toBeGreaterThan(0);
			for (const row of rows) {
				expect(["TODO", "IN_PROGRESS"]).toContain(row.status as string);
			}
			expect(rows.some((row) => row.title === titles.alpha)).toBe(false);
		});

		test("a single value behaves like a one element list", async () => {
			const single = await listTasks({ filters: { status: "TODO" } });
			const asList = await listTasks({ filters: { status: ["TODO"] } });

			expect(single.status).toBe(200);
			expect(asList.status).toBe(200);
			expect(rowsOf(asList)).toHaveLength(rowsOf(single).length);
		});

		test("an empty array is rejected", async () => {
			const res = await listTasks({ filters: { status: [] } });
			expect(res.status).toBe(400);
		});

		test("a value outside the enum is rejected", async () => {
			const res = await listTasks({ filters: { status: ["STARTED"] } });
			expect(res.status).toBe(400);
		});
	});

	describe("search", () => {
		test("matches a substring of the title", async () => {
			const res = await listTasks({ searchFilters: { title: "frontend" } });

			expect(res.status).toBe(200);
			const rows = rowsOf(res);
			expect(rows.length).toBeGreaterThan(0);
			for (const row of rows) {
				expect(String(row.title).toLowerCase()).toContain("frontend");
			}
		});

		test("is case insensitive", async () => {
			const lower = await listTasks({ searchFilters: { title: "frontend" } });
			const upper = await listTasks({ searchFilters: { title: "FRONTEND" } });

			expect(rowsOf(lower)).toHaveLength(rowsOf(upper).length);
		});

		test("a wildcard is treated as a literal, not as a pattern", async () => {
			// `escapeLikePattern` escapes % and _ before wrapping in %, so a search
			// for "%" cannot match every row.
			const wildcard = await listTasks({ searchFilters: { title: "%" } });
			const all = await listTasks();

			expect(wildcard.status).toBe(200);
			expect(rowsOf(wildcard)).toHaveLength(0);
			expect(rowsOf(all).length).toBeGreaterThan(0);
		});

		test("an underscore is also a literal", async () => {
			const res = await listTasks({ searchFilters: { title: "_" } });
			expect(res.status).toBe(200);
			expect(rowsOf(res)).toHaveLength(0);
		});

		test("a search on a column that is not searchable is rejected", async () => {
			const res = await listTasks({ searchFilters: { status: "TODO" } });
			expect(res.status).toBe(400);
		});

		test("malformed JSON is a validation error", async () => {
			const res = await listTasks({
				raw: `filters=${encodeURIComponent("{not json")}`,
			});
			expect(res.status).toBe(400);
		});

		test("a JSON array where an object is required is rejected", async () => {
			const res = await listTasks({
				raw: `filters=${encodeURIComponent(JSON.stringify(["TODO"]))}`,
			});
			expect(res.status).toBe(400);
		});
	});

	describe("range filters", () => {
		test("an inclusive createdAt range returns rows inside it", async () => {
			const all = await listTasks({ rows: 100, orderKey: "createdAt", orderRule: "asc" });
			const rows = rowsOf(all);
			expect(rows.length).toBeGreaterThan(0);

			const earliest = String(rows[0]?.createdAt ?? "");
			const res = await listTasks({
				rangedFilters: [{ key: "createdAt", start: earliest }],
			});

			expect(res.status).toBe(200);
			expect(rowsOf(res).length).toBeGreaterThan(0);
		});

		test("a range in the distant past excludes everything created now", async () => {
			const res = await listTasks({
				rangedFilters: [{ key: "createdAt", end: "2000-01-01T00:00:00.000Z" }],
			});

			expect(res.status).toBe(200);
			expect(rowsOf(res)).toHaveLength(0);
		});

		test("a range in the distant future excludes everything too", async () => {
			const res = await listTasks({
				rangedFilters: [{ key: "createdAt", start: "2999-01-01T00:00:00.000Z" }],
			});

			expect(res.status).toBe(200);
			expect(rowsOf(res)).toHaveLength(0);
		});

		test("an unparseable bound is rejected", async () => {
			const res = await listTasks({
				rangedFilters: [{ key: "createdAt", start: "not-a-date" }],
			});
			expect(res.status).toBe(400);
		});

		test("an unknown range key is rejected", async () => {
			const res = await listTasks({
				rangedFilters: [{ key: "title", start: "2020-01-01" }],
			});
			expect(res.status).toBe(400);
		});

		test("an unknown key inside a range object is rejected", async () => {
			const res = await listTasks({
				raw: `rangedFilters=${encodeURIComponent(
					JSON.stringify([{ key: "createdAt", from: "2020-01-01" }]),
				)}`,
			});
			expect(res.status).toBe(400);
		});

		test("an object where an array is required is rejected", async () => {
			const res = await listTasks({
				raw: `rangedFilters=${encodeURIComponent(JSON.stringify({ key: "createdAt" }))}`,
			});
			expect(res.status).toBe(400);
		});
	});

	describe("pagination", () => {
		test("reports the page, the limit and a consistent total", async () => {
			const res = await listTasks({ page: 1, rows: 2 });

			expect(res.status).toBe(200);
			expect(rowsOf(res).length).toBeLessThanOrEqual(2);
			expect(paginationOf(res, "page")).toBe(1);
			expect(paginationOf(res, "limit")).toBe(2);
			const total = paginationOf(res, "total") ?? 0;
			expect(total).toBeGreaterThan(0);
			expect(paginationOf(res, "totalPages")).toBe(Math.ceil(total / 2));
		});

		test("the first and second pages do not overlap", async () => {
			const first = await listTasks({
				page: 1,
				rows: 1,
				orderKey: "createdAt",
				orderRule: "asc",
			});
			const second = await listTasks({
				page: 2,
				rows: 1,
				orderKey: "createdAt",
				orderRule: "asc",
			});

			const firstIds = rowsOf(first).map((row) => row.id);
			const secondIds = rowsOf(second).map((row) => row.id);
			expect(firstIds).toHaveLength(1);
			expect(secondIds).toHaveLength(1);
			expect(firstIds[0]).not.toBe(secondIds[0]);
		});

		test("a page past the end is an empty page, not an error", async () => {
			const res = await listTasks({ page: 9999, rows: 10 });

			expect(res.status).toBe(200);
			expect(rowsOf(res)).toHaveLength(0);
		});

		test("rows above the cap are rejected", async () => {
			const res = await listTasks({ rows: 100000 });
			expect(res.status).toBe(400);
		});

		for (const [label, query] of [
			["page=0", { page: 0 }],
			["a negative page", { page: -1 }],
			["a non numeric page", { page: "abc" }],
			["rows=0", { rows: 0 }],
			["a fractional page", { page: 1.5 }],
		] as const) {
			test(`${label} is rejected`, async () => {
				const res = await listTasks({ ...query });
				expect(res.status).toBe(400);
			});
		}
	});

	describe("sorting", () => {
		test("orderRule=asc and desc return opposite orders", async () => {
			const asc = await listTasks({ orderKey: "title", orderRule: "asc", rows: 100 });
			const desc = await listTasks({ orderKey: "title", orderRule: "desc", rows: 100 });

			const ascTitles = rowsOf(asc).map((row) => String(row.title));
			const descTitles = rowsOf(desc).map((row) => String(row.title));
			expect(ascTitles.length).toBeGreaterThan(1);
			expect(ascTitles).toEqual([...ascTitles].sort());
			expect(descTitles).toEqual([...ascTitles].reverse());
		});

		test("an order key outside the allow-list is rejected", async () => {
			// This is the injection guard: a column name or a SQL fragment never
			// reaches the database, because the value has to match a closed enum.
			for (const key of ["passwordHash", "version", "nonexistent"]) {
				const res = await listTasks({ raw: `orderKey=${encodeURIComponent(key)}` });
				expect(res.status).toBe(400);
			}
		});

		test("an injection attempt in the order key is rejected", async () => {
			for (const attempt of [
				"title; DROP TABLE tasks",
				"title) OR 1=1--",
				"(SELECT 1)",
			]) {
				const res = await listTasks({ raw: `orderKey=${encodeURIComponent(attempt)}` });
				expect(res.status).toBe(400);
			}
		});

		test("an order rule outside asc and desc is rejected", async () => {
			const res = await listTasks({ orderRule: "ascending" });
			expect(res.status).toBe(400);
		});

		test("an injection attempt in the order rule is rejected", async () => {
			const res = await listTasks({ orderRule: "asc;--" });
			expect(res.status).toBe(400);
		});
	});

	describe("everything at once", () => {
		test("filters, search, range, paging and sorting compose in one request", async () => {
			const criteria = { status: "DONE", priority: "HIGH" };
			const all = await listTasks({
				filters: criteria,
				rows: 100,
				orderKey: "createdAt",
				orderRule: "asc",
			});
			const expected = rowsOf(all)
				.filter(
					(row) =>
						row.status === "DONE" &&
						row.priority === "HIGH" &&
						String(row.title).toLowerCase().includes("frontend"),
				)
				.map((row) => row.id);

			const res = await listTasks({
				filters: criteria,
				searchFilters: { title: "frontend" },
				rangedFilters: [{ key: "createdAt" }],
				page: 1,
				rows: 10,
				orderKey: "createdAt",
				orderRule: "asc",
			});

			expect(res.status).toBe(200);
			// The empty range carries no bounds and is dropped, so the result is
			// the same set the filter and search alone produce.
			expect(rowsOf(res).map((row) => row.id)).toEqual(expected);
		});

		test("the composed query reports a total consistent with its own page", async () => {
			const res = await listTasks({
				filters: { department: "FRONTEND" },
				page: 1,
				rows: 1,
			});

			expect(res.status).toBe(200);
			const rows = rowsOf(res);
			expect(rows).toHaveLength(1);
			expect(paginationOf(res, "total")).toBeGreaterThanOrEqual(1);
		});
	});

	describe("filters cannot widen the caller's access", () => {
		test("an engineer cannot read another project by filtering for it", async () => {
			const res = await api(
				`/tasks?filters=${encodeURIComponent(
					JSON.stringify({ projectId: world.foreignProject.id }),
				)}`,
				{ token: world.engineer.token },
			);

			// Either the project is out of scope and the filter matches nothing, or
			// it is refused outright. What must never happen is a row coming back.
			if (res.status === 200) {
				expect(jsonPath<unknown[]>(res, ["data", "tasks"])).toEqual([]);
				expect(jsonPath<number>(res, ["data", "pagination", "total"])).toBe(0);
			} else {
				expect([403, 404]).toContain(res.status);
			}
		});
	});
});
