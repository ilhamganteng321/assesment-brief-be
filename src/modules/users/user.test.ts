import { describe, expect, test } from "bun:test";
import type { UserContext } from "../authorization/authorization.types";
import {
	PERMISSION_MATRIX,
	Permission,
} from "../authorization/authorization.types";
import { canListUsers, canViewUser, getVisibleUserFields } from "./user.policy";
import {
	MAX_USER_ROWS,
	USER_DEPARTMENTS,
	USER_FILTER_FIELDS,
	USER_ORDER_FIELDS,
	USER_ROLES,
	USER_SEARCH_FIELDS,
	userIdParamsSchema,
	userListQuerySchema,
} from "./user.schema";

const pm: UserContext = { id: "pm-1", role: "PM", department: "PRODUCT" };
const internal: UserContext = {
	id: "fe-1",
	role: "INTERNAL",
	department: "FRONTEND",
};
const client: UserContext = {
	id: "cl-1",
	role: "CLIENT",
	department: "CLIENT",
};

describe("user directory policy", () => {
	test("only a project manager may browse the directory", () => {
		expect(canListUsers(pm)).toBe(true);
		expect(canListUsers(internal)).toBe(false);
		expect(canListUsers(client)).toBe(false);
	});

	test("the gate is a permission, not a role check at the call site", () => {
		expect(PERMISSION_MATRIX.PM).toContain(Permission.USER_READ);
		expect(PERMISSION_MATRIX.INTERNAL).not.toContain(Permission.USER_READ);
		expect(PERMISSION_MATRIX.CLIENT).not.toContain(Permission.USER_READ);
	});

	// Reading one profile is the shape most likely to need a narrower rule than
	// browsing everything, so it is a separate decision rather than a delegation.
	test("viewing a single user follows its own gate", () => {
		expect(canViewUser(pm)).toBe(true);
		expect(canViewUser(internal)).toBe(false);
		expect(canViewUser(client)).toBe(false);
	});

	// The whole point of naming the columns: nothing security-related is even on
	// the type, so there is no projection that could leak it by accident.
	test("the visible fields are exactly the non-secret row", () => {
		expect(getVisibleUserFields(pm)).toEqual([
			"id",
			"name",
			"email",
			"role",
			"department",
			"createdAt",
		]);
		for (const field of getVisibleUserFields(pm)) {
			expect(String(field).toLowerCase()).not.toContain("password");
			expect(String(field).toLowerCase()).not.toContain("token");
			expect(String(field).toLowerCase()).not.toContain("hash");
		}
	});

	test("every role sees the same fields once the gate is passed", () => {
		expect(getVisibleUserFields(internal)).toEqual(getVisibleUserFields(pm));
	});
});

describe("user directory query contract", () => {
	test("defaults to the first page with the default row count", () => {
		const parsed = userListQuerySchema.parse({});

		expect(parsed.page).toBe(1);
		expect(parsed.rows).toBe(20);
		expect(parsed.filters).toEqual({});
		expect(parsed.searchFilters).toEqual({});
		expect(parsed.rangedFilters).toEqual([]);
		expect(parsed.orderKey).toBeNull();
		expect(parsed.orderRule).toBe("desc");
	});

	test("parses a role filter", () => {
		expect(
			userListQuerySchema.parse({
				filters: JSON.stringify({ role: "INTERNAL" }),
			}).filters,
		).toEqual({ role: "INTERNAL" });
	});

	// "PM or INTERNAL" is one request rather than two, matching the array support
	// the shared list contract already gives every other filter.
	test("parses multiple roles and multiple departments", () => {
		const parsed = userListQuerySchema.parse({
			filters: JSON.stringify({
				role: ["PM", "INTERNAL"],
				department: ["FRONTEND", "BACKEND"],
			}),
		});

		expect(parsed.filters).toEqual({
			role: ["PM", "INTERNAL"],
			department: ["FRONTEND", "BACKEND"],
		});
	});

	test("parses name and email searches", () => {
		const parsed = userListQuerySchema.parse({
			searchFilters: JSON.stringify({ name: "john" }),
		});
		const byEmail = userListQuerySchema.parse({
			searchFilters: JSON.stringify({ email: "example.com" }),
		});

		expect(parsed.searchFilters).toEqual({ name: "john" });
		expect(byEmail.searchFilters).toEqual({ email: "example.com" });
	});

	test("rejects an unknown role", () => {
		expect(() =>
			userListQuerySchema.parse({
				filters: JSON.stringify({ role: "SUPERUSER" }),
			}),
		).toThrow();
		expect(() =>
			userListQuerySchema.parse({
				filters: JSON.stringify({ role: ["PM", "SUPERUSER"] }),
			}),
		).toThrow();
	});

	test("rejects an unknown department", () => {
		expect(() =>
			userListQuerySchema.parse({
				filters: JSON.stringify({ department: "MARKETING" }),
			}),
		).toThrow();
	});

	// The order key is a closed set, which is what makes it safe to sort by: an
	// unknown value is refused rather than reaching the query.
	test("rejects an unknown order key", () => {
		expect(() =>
			userListQuerySchema.parse({ orderKey: "passwordHash" }),
		).toThrow();
		expect(() =>
			userListQuerySchema.parse({ orderKey: "name; DROP TABLE" }),
		).toThrow();
		expect(() => userListQuerySchema.parse({ orderKey: "id" })).toThrow();
	});

	test("rejects out of range paging", () => {
		expect(() => userListQuerySchema.parse({ page: 0 })).toThrow();
		expect(() => userListQuerySchema.parse({ page: 1.5 })).toThrow();
		expect(() => userListQuerySchema.parse({ rows: 0 })).toThrow();
		expect(() =>
			userListQuerySchema.parse({ rows: MAX_USER_ROWS + 1 }),
		).toThrow();
	});

	test("rejects a filter or search field outside the allow-list", () => {
		expect(() =>
			userListQuerySchema.parse({
				filters: JSON.stringify({ passwordHash: "x" }),
			}),
		).toThrow();
		expect(() =>
			userListQuerySchema.parse({
				searchFilters: JSON.stringify({ passwordHash: "x" }),
			}),
		).toThrow();
		expect(() =>
			userListQuerySchema.parse({
				filters: JSON.stringify({ createdAt: "2026-01-01" }),
			}),
		).toThrow();
	});

	test("rejects an unknown query parameter rather than ignoring it", () => {
		expect(() => userListQuerySchema.parse({ search: "john" })).toThrow();
		expect(() => userListQuerySchema.parse({ limit: 10 })).toThrow();
	});

	test("rejects malformed JSON and non-object filter payloads", () => {
		expect(() => userListQuerySchema.parse({ filters: "{not json" })).toThrow();
		expect(() => userListQuerySchema.parse({ filters: "[1,2]" })).toThrow();
	});

	test("the allow-lists cover only real columns", () => {
		expect([...USER_FILTER_FIELDS]).toEqual(["id", "role", "department"]);
		expect([...USER_SEARCH_FIELDS]).toEqual(["name", "email"]);
		expect([...USER_ORDER_FIELDS]).toEqual([
			"name",
			"email",
			"role",
			"department",
			"createdAt",
		]);
	});

	test("the role and department lists match the database enums", () => {
		expect([...USER_ROLES]).toEqual(["PM", "INTERNAL", "CLIENT"]);
		expect([...USER_DEPARTMENTS]).toEqual([
			"PRODUCT",
			"UI_UX",
			"FRONTEND",
			"BACKEND",
			"CLIENT",
		]);
	});
});

describe("user id params", () => {
	test("accepts a uuid", () => {
		expect(
			userIdParamsSchema.parse({
				userId: "3c9a1e8a-6d5b-4f21-9c3f-8f0d1a2b3c4d",
			}),
		).toEqual({ userId: "3c9a1e8a-6d5b-4f21-9c3f-8f0d1a2b3c4d" });
	});

	test("rejects anything that is not a uuid", () => {
		expect(() => userIdParamsSchema.parse({ userId: "not-a-uuid" })).toThrow();
		expect(() => userIdParamsSchema.parse({ userId: "" })).toThrow();
		expect(() => userIdParamsSchema.parse({})).toThrow();
	});
});
