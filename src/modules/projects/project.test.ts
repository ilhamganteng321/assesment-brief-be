import { describe, expect, test } from "bun:test";
import type {
	ProjectAuthorizationContext,
	ProjectStatus,
	UserContext,
} from "../authorization/authorization.types";
import {
	canChangeProjectStatus,
	canCreateProject,
	canDeleteProject,
	canManageProjectMembers,
	canSearchProjectMemberCandidates,
	canUpdateProject,
	canUseInternalProjectApi,
	canViewProject,
} from "./project.policy";
import {
	addProjectMemberSchema,
	createProjectSchema,
	MAX_MEMBER_CANDIDATE_ROWS,
	MIN_MEMBER_CANDIDATE_SEARCH,
	projectListQuerySchema,
	projectMemberCandidatesQuerySchema,
	updateProjectRequestSchema,
	updateProjectStatusSchema,
} from "./project.schema";
import {
	canTransitionProjectStatus,
	getNextProjectStatuses,
	isArchivedProject,
	PROJECT_STATUS_TRANSITIONS,
	validateProjectStatusTransition,
} from "./project-lifecycle";

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
		const parsed = updateProjectRequestSchema.parse({ status: "COMPLETED" });
		expect(parsed).toEqual({ status: "COMPLETED" });
	});

	test("update rejects invalid status values", () => {
		expect(() =>
			updateProjectRequestSchema.parse({ status: "DELETED" }),
		).toThrow();
	});

	test("update rejects id and timestamp fields", () => {
		expect(() => updateProjectRequestSchema.parse({ id: "proj" })).toThrow();
		expect(() =>
			updateProjectRequestSchema.parse({ updatedAt: null }),
		).toThrow();
		expect(() =>
			updateProjectRequestSchema.parse({ deletedAt: null }),
		).toThrow();
	});

	// Mass assignment: the strict object is the boundary. A field the product
	// does not expose is rejected outright rather than dropped, so a client that
	// sends one is told rather than left believing it took effect.
	test("update rejects a relationship or membership field", () => {
		expect(() =>
			updateProjectRequestSchema.parse({ name: "X", members: [] }),
		).toThrow();
		expect(() =>
			updateProjectRequestSchema.parse({ name: "X", tasks: [] }),
		).toThrow();
	});

	test("update rejects an empty payload", () => {
		expect(() => updateProjectRequestSchema.parse({})).toThrow();
	});

	test("the status route accepts a status and nothing else", () => {
		expect(updateProjectStatusSchema.parse({ status: "ARCHIVED" })).toEqual({
			status: "ARCHIVED",
		});
		expect(() =>
			updateProjectStatusSchema.parse({ status: "ARCHIVED", name: "Renamed" }),
		).toThrow();
		expect(() => updateProjectStatusSchema.parse({})).toThrow();
		expect(() => updateProjectStatusSchema.parse({ status: "OPEN" })).toThrow();
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

describe("project lifecycle", () => {
	const allStatuses: readonly ProjectStatus[] = [
		"PLANNING",
		"ACTIVE",
		"COMPLETED",
		"ARCHIVED",
	];

	test("the lifecycle only ever moves forward one step at a time", () => {
		expect(PROJECT_STATUS_TRANSITIONS.PLANNING).toEqual(["ACTIVE"]);
		expect(PROJECT_STATUS_TRANSITIONS.ACTIVE).toEqual(["COMPLETED"]);
		expect(PROJECT_STATUS_TRANSITIONS.COMPLETED).toEqual(["ARCHIVED"]);
	});

	test("ARCHIVED is terminal: there is no reopen", () => {
		expect(PROJECT_STATUS_TRANSITIONS.ARCHIVED).toEqual([]);
		expect(getNextProjectStatuses("ARCHIVED")).toEqual([]);
	});

	test("ACTIVE may not skip straight to ARCHIVED", () => {
		expect(canTransitionProjectStatus("ACTIVE", "ARCHIVED")).toBe(false);
	});

	test("no status may move backwards", () => {
		expect(canTransitionProjectStatus("COMPLETED", "ACTIVE")).toBe(false);
		expect(canTransitionProjectStatus("ARCHIVED", "ACTIVE")).toBe(false);
		expect(canTransitionProjectStatus("ARCHIVED", "COMPLETED")).toBe(false);
		expect(canTransitionProjectStatus("ACTIVE", "PLANNING")).toBe(false);
	});

	// The table is the whole rule, so it is worth proving there is no pair it
	// quietly permits beyond the three forward steps.
	test("exactly the forward steps are permitted", () => {
		const permitted: string[] = [];
		for (const from of allStatuses) {
			for (const to of allStatuses) {
				if (canTransitionProjectStatus(from, to)) {
					permitted.push(`${from}->${to}`);
				}
			}
		}
		expect(permitted).toEqual([
			"PLANNING->ACTIVE",
			"ACTIVE->COMPLETED",
			"COMPLETED->ARCHIVED",
		]);
	});

	test("a legal transition does not throw", () => {
		expect(() =>
			validateProjectStatusTransition("ACTIVE", "COMPLETED"),
		).not.toThrow();
		expect(() =>
			validateProjectStatusTransition("COMPLETED", "ARCHIVED"),
		).not.toThrow();
	});

	test("an illegal transition throws a typed 409 conflict", () => {
		for (const [from, to] of [
			["ACTIVE", "ARCHIVED"],
			["COMPLETED", "ACTIVE"],
			["ARCHIVED", "ACTIVE"],
			["ARCHIVED", "COMPLETED"],
		] as const) {
			let thrown: unknown;
			try {
				validateProjectStatusTransition(from, to);
			} catch (error) {
				thrown = error;
			}
			expect(thrown).toBeInstanceOf(Error);
			expect((thrown as { status: number }).status).toBe(409);
			expect((thrown as { code: string }).code).toBe(
				"INVALID_PROJECT_STATUS_TRANSITION",
			);
			expect((thrown as { message: string }).message).toBe(
				`Project cannot transition from ${from} to ${to}.`,
			);
		}
	});

	// A retry of a write whose response was lost must not fail with a conflict
	// the caller can do nothing about.
	test("re-asserting the current status is a no-op, not a transition", () => {
		for (const status of allStatuses) {
			expect(() =>
				validateProjectStatusTransition(status, status),
			).not.toThrow();
		}
	});

	test("only ARCHIVED is read-only", () => {
		expect(isArchivedProject("ARCHIVED")).toBe(true);
		expect(isArchivedProject("COMPLETED")).toBe(false);
		expect(isArchivedProject("ACTIVE")).toBe(false);
		expect(isArchivedProject("PLANNING")).toBe(false);
	});
});

describe("project status policy", () => {
	// The lifecycle grants nobody a permission they did not already hold: it
	// constrains which status a caller who may update can set, nothing more.
	test("changing a project's status follows the project update permission", () => {
		expect(canChangeProjectStatus(pm)).toBe(true);
		expect(canChangeProjectStatus(internal)).toBe(false);
		expect(canChangeProjectStatus(client)).toBe(false);
	});

	test("it matches the general update permission for every role", () => {
		for (const user of [pm, internal, client]) {
			expect(canChangeProjectStatus(user)).toBe(canUpdateProject(user));
		}
	});
});

describe("project membership policy", () => {
	test("only a project manager may change membership", () => {
		expect(canManageProjectMembers(pm)).toBe(true);
		expect(canManageProjectMembers(internal)).toBe(false);
		expect(canManageProjectMembers(client)).toBe(false);
	});

	// The candidate search exists only to serve the add-member flow. Handing it to
	// a role that cannot add would expose the whole organisation's names, emails
	// and departments to anyone who can open a project, which is a larger
	// disclosure than the feature needs.
	test("candidate search is gated by the same rule as adding", () => {
		expect(canSearchProjectMemberCandidates(pm)).toBe(true);
		expect(canSearchProjectMemberCandidates(internal)).toBe(false);
		expect(canSearchProjectMemberCandidates(client)).toBe(false);
	});

	test("candidate search never widens the permission to add", () => {
		for (const user of [pm, internal, client]) {
			if (canSearchProjectMemberCandidates(user)) {
				expect(canManageProjectMembers(user)).toBe(true);
			}
		}
	});
});

describe("project member candidate query contract", () => {
	test("defaults to an empty search on the first page", () => {
		const parsed = projectMemberCandidatesQuerySchema.parse({});

		expect(parsed).toEqual({ search: "", page: 1, rows: 10 });
	});

	test("trims the search and coerces paging from query strings", () => {
		const parsed = projectMemberCandidatesQuerySchema.parse({
			search: "  john  ",
			page: "2",
			rows: "5",
		});

		expect(parsed).toEqual({ search: "john", page: 2, rows: 5 });
	});

	test("rejects an over-long search", () => {
		expect(() =>
			projectMemberCandidatesQuerySchema.parse({ search: "a".repeat(151) }),
		).toThrow();
	});

	test("rejects out of range paging", () => {
		expect(() =>
			projectMemberCandidatesQuerySchema.parse({ page: 0 }),
		).toThrow();
		expect(() =>
			projectMemberCandidatesQuerySchema.parse({ page: 1.5 }),
		).toThrow();
		expect(() =>
			projectMemberCandidatesQuerySchema.parse({ rows: 0 }),
		).toThrow();
		expect(() =>
			projectMemberCandidatesQuerySchema.parse({
				rows: MAX_MEMBER_CANDIDATE_ROWS + 1,
			}),
		).toThrow();
	});

	test("rejects an unknown parameter rather than ignoring it", () => {
		expect(() =>
			projectMemberCandidatesQuerySchema.parse({ limit: 10 }),
		).toThrow();
		expect(() =>
			projectMemberCandidatesQuerySchema.parse({ filters: "{}" }),
		).toThrow();
	});

	// The minimum is what keeps a one-character prefix from scanning the whole
	// user table; the service uses it to short-circuit rather than to error.
	test("the minimum search length is two characters", () => {
		expect(MIN_MEMBER_CANDIDATE_SEARCH).toBe(2);
	});
});
