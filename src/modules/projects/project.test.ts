import { describe, expect, test } from "bun:test";
import type {
	ProjectAuthorizationContext,
	UserContext,
} from "../authorization/authorization.types";
import {
	canCreateProject,
	canDeleteProject,
	canManageProjectMembers,
	canUpdateProject,
	canUseInternalProjectApi,
	canViewProject,
} from "./project.policy";
import {
	addProjectMemberSchema,
	createProjectSchema,
	projectListQuerySchema,
	updateProjectSchema,
} from "./project.schema";

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

function activeProject(
	memberIds: readonly string[],
): ProjectAuthorizationContext {
	return {
		id: "proj-1",
		status: "ACTIVE",
		memberships: memberIds.map((userId) => ({ userId })),
	};
}

describe("project schema", () => {
	test("create accepts a minimal payload", () => {
		const parsed = createProjectSchema.parse({ name: "New Project" });
		expect(parsed).toEqual({ name: "New Project" });
	});

	test("create trims the name and accepts optional fields", () => {
		const parsed = createProjectSchema.parse({
			name: "  Website Revamp  ",
			description: "Redesign the marketing site",
			clientName: "Acme Corp",
		});
		expect(parsed.name).toBe("Website Revamp");
		expect(parsed.description).toBe("Redesign the marketing site");
		expect(parsed.clientName).toBe("Acme Corp");
	});

	test("create rejects server-controlled fields", () => {
		expect(() =>
			createProjectSchema.parse({
				name: "X",
				id: "3c9a1e8a-6d5b-4f21-9c3f-8f0d1a2b3c4d",
			}),
		).toThrow();
		expect(() =>
			createProjectSchema.parse({ name: "X", createdAt: "2026-01-01" }),
		).toThrow();
		expect(() =>
			createProjectSchema.parse({ name: "X", deletedAt: null }),
		).toThrow();
		expect(() =>
			createProjectSchema.parse({ name: "X", members: [] }),
		).toThrow();
	});

	test("create validates the optional status", () => {
		expect(
			createProjectSchema.parse({ name: "X", status: "PLANNING" }),
		).toEqual({ name: "X", status: "PLANNING" });
		expect(() =>
			createProjectSchema.parse({ name: "X", status: "DELETED" }),
		).toThrow();
	});

	test("create rejects empty or oversized names", () => {
		expect(() => createProjectSchema.parse({ name: "   " })).toThrow();
		expect(() => createProjectSchema.parse({ name: "" })).toThrow();
		expect(() =>
			createProjectSchema.parse({ name: "x".repeat(151) }),
		).toThrow();
	});

	test("update accepts a single field", () => {
		const parsed = updateProjectSchema.parse({ status: "COMPLETED" });
		expect(parsed).toEqual({ status: "COMPLETED" });
	});

	test("update rejects invalid status values", () => {
		expect(() => updateProjectSchema.parse({ status: "DELETED" })).toThrow();
	});

	test("update rejects id and timestamp fields", () => {
		expect(() => updateProjectSchema.parse({ id: "proj" })).toThrow();
		expect(() => updateProjectSchema.parse({ updatedAt: null })).toThrow();
		expect(() => updateProjectSchema.parse({ deletedAt: null })).toThrow();
	});

	test("update rejects an empty payload", () => {
		expect(() => updateProjectSchema.parse({})).toThrow();
	});

	test("add member requires a valid uuid", () => {
		expect(() =>
			addProjectMemberSchema.parse({ userId: "not-a-uuid" }),
		).toThrow();
		expect(() =>
			addProjectMemberSchema.parse({
				userId: "3c9a1e8a-6d5b-4f21-9c3f-8f0d1a2b3c4d",
			}),
		).not.toThrow();
	});
});

describe("project list query contract", () => {
	test("defaults to the first page with the default row count", () => {
		const parsed = projectListQuerySchema.parse({});

		expect(parsed.page).toBe(1);
		expect(parsed.rows).toBe(20);
		expect(parsed.filters).toEqual({});
		expect(parsed.searchFilters).toEqual({});
		expect(parsed.rangedFilters).toEqual([]);
		expect(parsed.orderKey).toBeNull();
		expect(parsed.orderRule).toBe("desc");
	});

	test("parses filters from JSON", () => {
		const parsed = projectListQuerySchema.parse({
			filters: JSON.stringify({ status: "ACTIVE" }),
		});

		expect(parsed.filters).toEqual({ status: "ACTIVE" });
	});

	test("parses multiple status filters", () => {
		const parsed = projectListQuerySchema.parse({
			filters: JSON.stringify({ status: ["ACTIVE", "PLANNING"] }),
		});

		expect(parsed.filters).toEqual({
			status: ["ACTIVE", "PLANNING"],
		});
	});

	test("parses searchFilters from JSON", () => {
		const parsed = projectListQuerySchema.parse({
			searchFilters: JSON.stringify({ name: "website" }),
		});

		expect(parsed.searchFilters).toEqual({ name: "website" });
	});

	test("parses rangedFilters from JSON", () => {
		const parsed = projectListQuerySchema.parse({
			rangedFilters: JSON.stringify([
				{ key: "createdAt", start: "2026-01-01", end: "2026-12-31" },
			]),
		});

		expect(parsed.rangedFilters).toEqual([
			{ key: "createdAt", start: "2026-01-01", end: "2026-12-31" },
		]);
	});

	test("parses pagination, ordering and coerces numeric strings", () => {
		const parsed = projectListQuerySchema.parse({
			page: "3",
			rows: "50",
			orderKey: "name",
			orderRule: "asc",
		});

		expect(parsed.page).toBe(3);
		expect(parsed.rows).toBe(50);
		expect(parsed.orderKey).toBe("name");
		expect(parsed.orderRule).toBe("asc");
	});

	test("rejects unknown query parameters", () => {
		expect(() => projectListQuerySchema.parse({ search: "x" })).toThrow();
		expect(() => projectListQuerySchema.parse({ limit: 10 })).toThrow();
		expect(() =>
			projectListQuerySchema.parse({ sortBy: "createdAt" }),
		).toThrow();
	});

	test("rejects malformed JSON and non-object payloads", () => {
		expect(() =>
			projectListQuerySchema.parse({ filters: "{not json" }),
		).toThrow();
		expect(() => projectListQuerySchema.parse({ filters: "[1,2]" })).toThrow();
		expect(() => projectListQuerySchema.parse({ filters: '"a"' })).toThrow();
		expect(() =>
			projectListQuerySchema.parse({ rangedFilters: '{"key":"createdAt"}' }),
		).toThrow();
	});

	test("rejects unknown or unsupported filter fields", () => {
		expect(() =>
			projectListQuerySchema.parse({
				filters: JSON.stringify({ deletedAt: null }),
			}),
		).toThrow();
		expect(() =>
			projectListQuerySchema.parse({
				filters: JSON.stringify({ name: "x" }),
			}),
		).toThrow();
		expect(() =>
			projectListQuerySchema.parse({
				searchFilters: JSON.stringify({ deletedAt: "x" }),
			}),
		).toThrow();
	});

	test("rejects invalid filter values", () => {
		expect(() =>
			projectListQuerySchema.parse({
				filters: JSON.stringify({ status: "DELETED" }),
			}),
		).toThrow();
		expect(() =>
			projectListQuerySchema.parse({
				filters: JSON.stringify({ id: "not-a-uuid" }),
			}),
		).toThrow();
		expect(() =>
			projectListQuerySchema.parse({
				searchFilters: JSON.stringify({ name: "  " }),
			}),
		).toThrow();
	});

	test("rejects invalid ranged filter keys and values", () => {
		expect(() =>
			projectListQuerySchema.parse({
				rangedFilters: JSON.stringify([{ key: "name", start: "2026-01-01" }]),
			}),
		).toThrow();
		expect(() =>
			projectListQuerySchema.parse({
				rangedFilters: JSON.stringify([
					{ key: "createdAt", start: "not-a-date" },
				]),
			}),
		).toThrow();
		expect(() =>
			projectListQuerySchema.parse({
				rangedFilters: JSON.stringify([
					{ key: "createdAt", unknown: "2026-01-01" },
				]),
			}),
		).toThrow();
	});

	test("drops a range that has neither a start nor an end", () => {
		const parsed = projectListQuerySchema.parse({
			rangedFilters: JSON.stringify([
				{ key: "createdAt", start: null, end: undefined },
			]),
		});

		expect(parsed.rangedFilters).toEqual([]);
	});

	test("keeps a one sided range", () => {
		const parsed = projectListQuerySchema.parse({
			rangedFilters: JSON.stringify([{ key: "updatedAt", end: "2026-12-31" }]),
		});

		expect(parsed.rangedFilters).toEqual([
			{ key: "updatedAt", end: "2026-12-31" },
		]);
	});

	test("rejects out of range pagination and unknown order keys", () => {
		expect(() => projectListQuerySchema.parse({ page: 0 })).toThrow();
		expect(() => projectListQuerySchema.parse({ page: 1.5 })).toThrow();
		expect(() => projectListQuerySchema.parse({ rows: 0 })).toThrow();
		expect(() => projectListQuerySchema.parse({ rows: 1000 })).toThrow();
		expect(() =>
			projectListQuerySchema.parse({ orderKey: "passwordHash" }),
		).toThrow();
		expect(() =>
			projectListQuerySchema.parse({ orderRule: "ascending" }),
		).toThrow();
	});
});

describe("project policy", () => {
	test("only PM can create projects", () => {
		expect(canCreateProject(pm)).toBe(true);
		expect(canCreateProject(internal)).toBe(false);
		expect(canCreateProject(client)).toBe(false);
	});

	test("only PM can update projects", () => {
		expect(canUpdateProject(pm)).toBe(true);
		expect(canUpdateProject(internal)).toBe(false);
		expect(canUpdateProject(client)).toBe(false);
	});

	test("only PM can delete projects", () => {
		expect(canDeleteProject(pm)).toBe(true);
		expect(canDeleteProject(internal)).toBe(false);
		expect(canDeleteProject(client)).toBe(false);
	});

	test("only PM can manage project members", () => {
		expect(canManageProjectMembers(pm)).toBe(true);
		expect(canManageProjectMembers(internal)).toBe(false);
		expect(canManageProjectMembers(client)).toBe(false);
	});

	test("PM can view any project without membership", () => {
		expect(canViewProject(pm, activeProject([]))).toBe(true);
	});

	test("INTERNAL can only view projects they are a member of", () => {
		expect(canViewProject(internal, activeProject(["fe-1"]))).toBe(true);
		expect(canViewProject(internal, activeProject([]))).toBe(false);
		expect(canViewProject(internal, activeProject(["other-user"]))).toBe(false);
	});

	test("CLIENT can only view projects they are associated with", () => {
		expect(canViewProject(client, activeProject(["cl-1"]))).toBe(true);
		expect(canViewProject(client, activeProject([]))).toBe(false);
	});

	test("the internal project api is limited to internal roles", () => {
		expect(canUseInternalProjectApi(pm)).toBe(true);
		expect(canUseInternalProjectApi(internal)).toBe(true);
		expect(canUseInternalProjectApi(client)).toBe(false);
	});
});
