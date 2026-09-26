import { describe, expect, test } from "bun:test";
import { toTimestamp, toVarchar } from "../../prisma/scalars";
import type {
	ProjectAuthorizationContext,
	TaskAuthorizationContext,
	UserContext,
} from "../authorization/authorization.types";
import { TaskVersionConflictError } from "./task.errors";
import {
	canChangeAssignment,
	canChangeClientVisibility,
	canChangeTaskStatus,
	canCreateTask,
	canDeleteTask,
	canEditTask,
	canEditTaskDescription,
	canEditTaskMetadata,
	canViewTask,
} from "./task.policy";
import {
	createFlatTaskSchema,
	createTaskSchema,
	DEFAULT_TASK_LIST_QUERY,
	flatTaskIdParamSchema,
	taskDeleteQuerySchema,
	taskListQuerySchema,
	taskOfficialListQuerySchema,
	updateTaskSchema,
} from "./task.schema";

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

function project(memberIds: readonly string[]): ProjectAuthorizationContext {
	return {
		id: "proj-1",
		status: "ACTIVE",
		memberships: memberIds.map((userId) => ({ userId })),
	};
}

function task(
	overrides: Partial<TaskAuthorizationContext> = {},
): TaskAuthorizationContext {
	return {
		id: "task-1",
		projectId: "proj-1",
		status: "TODO",
		assignedToId: null,
		clientVisible: false,
		...overrides,
	};
}

describe("task schema", () => {
	test("create accepts a minimal payload", () => {
		const parsed = createTaskSchema.parse({ title: "Build dashboard" });
		expect(parsed).toEqual({ title: "Build dashboard" });
	});

	test("create trims the title and accepts optional fields", () => {
		const parsed = createTaskSchema.parse({
			title: "  Build dashboard  ",
			description: "Create the API",
			assignedToId: "3c9a1e8a-6d5b-4f21-9c3f-8f0d1a2b3c4d",
			status: "IN_PROGRESS",
			clientVisible: true,
		});
		expect(parsed.title).toBe("Build dashboard");
		expect(parsed.description).toBe("Create the API");
		expect(parsed.status).toBe("IN_PROGRESS");
		expect(parsed.clientVisible).toBe(true);
	});

	test("create rejects server-controlled fields", () => {
		expect(() => createTaskSchema.parse({ title: "X", version: 1 })).toThrow();
		expect(() =>
			createTaskSchema.parse({ title: "X", createdAt: "2026-01-01" }),
		).toThrow();
		expect(() =>
			createTaskSchema.parse({ title: "X", deletedAt: null }),
		).toThrow();
		expect(() =>
			createTaskSchema.parse({
				title: "X",
				id: "3c9a1e8a-6d5b-4f21-9c3f-8f0d1a2b3c4d",
			}),
		).toThrow();
	});

	test("create rejects empty or oversized titles", () => {
		expect(() => createTaskSchema.parse({ title: "   " })).toThrow();
		expect(() => createTaskSchema.parse({ title: "" })).toThrow();
		expect(() => createTaskSchema.parse({ title: "x".repeat(201) })).toThrow();
	});

	test("create rejects a non-uuid assignee", () => {
		expect(() =>
			createTaskSchema.parse({ title: "X", assignedToId: "not-a-uuid" }),
		).toThrow();
	});

	test("update requires the expected version", () => {
		const parsed = updateTaskSchema.parse({
			status: "DONE",
			version: 1,
		});
		expect(parsed).toEqual({ status: "DONE", version: 1 });
	});

	test("update rejects a missing version", () => {
		expect(() => updateTaskSchema.parse({ status: "DONE" })).toThrow();
		expect(() => updateTaskSchema.parse({ title: "X" })).toThrow();
	});

	test("update rejects invalid version values", () => {
		expect(() => updateTaskSchema.parse({ title: "X", version: 0 })).toThrow();
		expect(() => updateTaskSchema.parse({ title: "X", version: -1 })).toThrow();
		expect(() =>
			updateTaskSchema.parse({ title: "X", version: 3.5 }),
		).toThrow();
		expect(() =>
			updateTaskSchema.parse({ title: "X", version: "5" }),
		).toThrow();
		expect(() =>
			updateTaskSchema.parse({ title: "X", version: null }),
		).toThrow();
		expect(() => updateTaskSchema.parse({ title: "X", version: {} })).toThrow();
	});

	test("update rejects a version-only payload (no mutable field)", () => {
		expect(() => updateTaskSchema.parse({ version: 2 })).toThrow();
	});

	test("update rejects invalid status values", () => {
		expect(() =>
			updateTaskSchema.parse({ status: "STARTED", version: 1 }),
		).toThrow();
	});

	test("update rejects id and timestamp fields", () => {
		expect(() => updateTaskSchema.parse({ id: "task", version: 1 })).toThrow();
		expect(() =>
			updateTaskSchema.parse({ updatedAt: null, version: 1 }),
		).toThrow();
	});

	test("update rejects an empty payload", () => {
		expect(() => updateTaskSchema.parse({})).toThrow();
	});

	test("delete query requires a valid version", () => {
		expect(taskDeleteQuerySchema.parse({ version: "5" }).version).toBe(5);
		expect(() => taskDeleteQuerySchema.parse({})).toThrow();
		expect(() => taskDeleteQuerySchema.parse({ version: "0" })).toThrow();
		expect(() => taskDeleteQuerySchema.parse({ version: "-1" })).toThrow();
		expect(() => taskDeleteQuerySchema.parse({ version: "2.5" })).toThrow();
		expect(() => taskDeleteQuerySchema.parse({ version: "abc" })).toThrow();
	});

	test("a lost optimistic-lock race is a 409 that identifies the resource", () => {
		const conflict = new TaskVersionConflictError("task-7", 5, 6);

		expect(conflict.status).toBe(409);
		expect(conflict.code).toBe("CONCURRENT_MODIFICATION");
		expect(conflict.details).toEqual({
			resourceId: "task-7",
			taskId: "task-7",
			expectedVersion: 5,
			currentVersion: 6,
		});
		expect(conflict.message).toBe(
			"This task has been modified by another user. Please refresh and try again.",
		);
	});

	test("a conflict may carry the latest task without leaking a database detail", () => {
		const latestTask = {
			id: "task-7",
			projectId: "proj-1",
			assignedToId: null,
			title: toVarchar<200>("Build dashboard"),
			description: "Create responsive landing page",
			status: "IN_PROGRESS" as const,
			priority: "MEDIUM" as const,
			department: "PRODUCT" as const,
			clientVisible: false,
			version: 6,
			createdAt: toTimestamp("2026-01-01T00:00:00"),
			updatedAt: toTimestamp("2026-01-01T00:00:00"),
			isBlocked: false,
			blockedBy: [],
		};
		const conflict = new TaskVersionConflictError("task-7", 5, 6, latestTask);

		expect(conflict.details?.latestTask).toEqual(latestTask);
	});

	test("list query applies defaults", () => {
		const parsed = taskListQuerySchema.parse({});
		expect(parsed).toEqual({
			page: 1,
			limit: 20,
			clientVisible: undefined,
		});
	});

	test("list query coerces page and limit", () => {
		const parsed = taskListQuerySchema.parse({ page: "2", limit: "10" });
		expect(parsed.page).toBe(2);
		expect(parsed.limit).toBe(10);
	});

	test("list query parses clientVisible as a boolean", () => {
		expect(
			taskListQuerySchema.parse({ clientVisible: "true" }).clientVisible,
		).toBe(true);
		expect(
			taskListQuerySchema.parse({ clientVisible: "false" }).clientVisible,
		).toBe(false);
	});

	test("list query rejects invalid pages and uuids", () => {
		expect(() => taskListQuerySchema.parse({ page: "0" })).toThrow();
		expect(() => taskListQuerySchema.parse({ page: "abc" })).toThrow();
		expect(() => taskListQuerySchema.parse({ assignedToId: "nope" })).toThrow();
	});
});

describe("task policy", () => {
	test("only PM can create tasks", () => {
		expect(canCreateTask(pm)).toBe(true);
		expect(canCreateTask(internal)).toBe(false);
		expect(canCreateTask(client)).toBe(false);
	});

	test("only PM can delete tasks", () => {
		expect(canDeleteTask(pm)).toBe(true);
		expect(canDeleteTask(internal)).toBe(false);
		expect(canDeleteTask(client)).toBe(false);
	});

	test("only PM can change assignment", () => {
		expect(canChangeAssignment(pm)).toBe(true);
		expect(canChangeAssignment(internal)).toBe(false);
		expect(canChangeAssignment(client)).toBe(false);
	});

	test("only PM can change client visibility", () => {
		expect(canChangeClientVisibility(pm)).toBe(true);
		expect(canChangeClientVisibility(internal)).toBe(false);
		expect(canChangeClientVisibility(client)).toBe(false);
	});

	test("only PM can edit the task description", () => {
		expect(canEditTaskDescription(pm)).toBe(true);
		expect(canEditTaskDescription(internal)).toBe(false);
		expect(canEditTaskDescription(client)).toBe(false);
	});

	test("PM can view any task without membership", () => {
		expect(canViewTask(pm, task(), project([]))).toBe(true);
	});

	test("INTERNAL can view tasks in projects they belong to", () => {
		expect(canViewTask(internal, task(), project(["fe-1"]))).toBe(true);
		expect(canViewTask(internal, task(), project([]))).toBe(false);
	});

	test("CLIENT can only view client-visible tasks in their project", () => {
		expect(
			canViewTask(client, task({ clientVisible: true }), project(["cl-1"])),
		).toBe(true);
		expect(
			canViewTask(client, task({ clientVisible: false }), project(["cl-1"])),
		).toBe(false);
		expect(
			canViewTask(client, task({ clientVisible: true }), project([])),
		).toBe(false);
	});

	test("PM can edit any task", () => {
		expect(canEditTask(pm, task(), project([]))).toBe(true);
	});

	test("INTERNAL can only edit tasks assigned to them", () => {
		expect(
			canEditTask(internal, task({ assignedToId: "fe-1" }), project(["fe-1"])),
		).toBe(true);
		expect(
			canEditTask(internal, task({ assignedToId: "other" }), project(["fe-1"])),
		).toBe(false);
	});

	test("CLIENT can never edit tasks", () => {
		expect(canEditTask(client, task(), project(["cl-1"]))).toBe(false);
	});

	test("PM can change task status (completion follows assignment)", () => {
		expect(
			canChangeTaskStatus(pm, task({ status: "TODO" }), "IN_PROGRESS"),
		).toBe(true);
		expect(
			canChangeTaskStatus(
				pm,
				task({ status: "IN_PROGRESS", assignedToId: "pm-1" }),
				"DONE",
			),
		).toBe(true);
		expect(
			canChangeTaskStatus(
				pm,
				task({ status: "IN_PROGRESS", assignedToId: "other" }),
				"DONE",
			),
		).toBe(false);
	});

	test("INTERNAL can only change status of their own task", () => {
		expect(
			canChangeTaskStatus(
				internal,
				task({ status: "TODO", assignedToId: "fe-1" }),
				"IN_PROGRESS",
			),
		).toBe(true);
		expect(
			canChangeTaskStatus(
				internal,
				task({ status: "TODO", assignedToId: "other" }),
				"IN_PROGRESS",
			),
		).toBe(false);
	});

	test("CLIENT cannot change task status", () => {
		expect(canChangeTaskStatus(client, task(), "IN_PROGRESS")).toBe(false);
	});
});

describe("task priority and department", () => {
	test("create accepts priority and department", () => {
		const parsed = createTaskSchema.parse({
			title: "Ship search",
			priority: "HIGH",
			department: "BACKEND",
		});
		expect(parsed.priority).toBe("HIGH");
		expect(parsed.department).toBe("BACKEND");
	});

	test("create rejects an unknown priority", () => {
		expect(() =>
			createTaskSchema.parse({ title: "Ship search", priority: "CRITICAL" }),
		).toThrow();
	});

	test("create rejects CLIENT as a task department", () => {
		expect(() =>
			createTaskSchema.parse({ title: "Ship search", department: "CLIENT" }),
		).toThrow();
	});

	test("update accepts priority and department", () => {
		const parsed = updateTaskSchema.parse({
			version: 1,
			priority: "URGENT",
			department: "FRONTEND",
		});
		expect(parsed.priority).toBe("URGENT");
		expect(parsed.department).toBe("FRONTEND");
	});

	test("update rejects CLIENT as a task department", () => {
		expect(() =>
			updateTaskSchema.parse({ version: 1, department: "CLIENT" }),
		).toThrow();
	});

	test("flat create requires a projectId in the payload", () => {
		const parsed = createFlatTaskSchema.parse({
			projectId: "3f0a9d2c-6b1e-4a55-9f3d-2c7b5e1d9a04",
			title: "Ship search",
			department: "PRODUCT",
		});
		expect(parsed.projectId).toBe("3f0a9d2c-6b1e-4a55-9f3d-2c7b5e1d9a04");
	});

	test("flat create rejects a non-uuid projectId", () => {
		expect(() =>
			createFlatTaskSchema.parse({ projectId: "nope", title: "x" }),
		).toThrow();
	});

	test("only PM can change task priority or department", () => {
		expect(canEditTaskMetadata(pm)).toBe(true);
		expect(canEditTaskMetadata(internal)).toBe(false);
		expect(canEditTaskMetadata(client)).toBe(false);
	});
});

describe("task official list query", () => {
	test("defaults are an empty first page ordered by newest", () => {
		expect(taskOfficialListQuerySchema.parse({})).toEqual({
			page: 1,
			rows: 20,
			filters: {},
			searchFilters: {},
			rangedFilters: [],
			orderKey: null,
			orderRule: "desc",
		});
		expect(DEFAULT_TASK_LIST_QUERY.page).toBe(1);
		expect(DEFAULT_TASK_LIST_QUERY.rows).toBe(20);
	});

	test("parses equality filters including priority and department", () => {
		const parsed = taskOfficialListQuerySchema.parse({
			filters: JSON.stringify({
				status: ["TODO", "IN_PROGRESS"],
				priority: "HIGH",
				department: ["BACKEND", "FRONTEND"],
				clientVisible: "false",
			}),
		});
		expect(parsed.filters.status).toEqual(["TODO", "IN_PROGRESS"]);
		expect(parsed.filters.priority).toBe("HIGH");
		expect(parsed.filters.department).toEqual(["BACKEND", "FRONTEND"]);
		expect(parsed.filters.clientVisible).toBe(false);
	});

	test("rejects a filter outside the allow-list", () => {
		const result = taskOfficialListQuerySchema.safeParse({
			filters: JSON.stringify({ deletedAt: "2026-01-01" }),
		});
		expect(result.success).toBe(false);
	});

	test("rejects an unknown priority inside filters", () => {
		const result = taskOfficialListQuerySchema.safeParse({
			filters: JSON.stringify({ priority: "CRITICAL" }),
		});
		expect(result.success).toBe(false);
	});

	test("parses search filters on title and description", () => {
		const parsed = taskOfficialListQuerySchema.parse({
			searchFilters: JSON.stringify({ title: "search" }),
		});
		expect(parsed.searchFilters).toEqual({ title: "search" });
	});

	test("rejects a search filter outside the allow-list", () => {
		const result = taskOfficialListQuerySchema.safeParse({
			searchFilters: JSON.stringify({ status: "TODO" }),
		});
		expect(result.success).toBe(false);
	});

	test("parses ranged filters and drops empty ranges", () => {
		const parsed = taskOfficialListQuerySchema.parse({
			rangedFilters: JSON.stringify([
				{ key: "createdAt", start: "2026-01-01T00:00:00.000Z" },
				{ key: "updatedAt", start: "2026-02-01", end: "2026-03-01" },
				{ key: "createdAt" },
			]),
		});
		expect(parsed.rangedFilters).toHaveLength(2);
		expect(parsed.rangedFilters[0]?.key).toBe("createdAt");
		expect(parsed.rangedFilters[1]?.end).toBe("2026-03-01");
	});

	test("rejects a ranged filter outside the allow-list", () => {
		const result = taskOfficialListQuerySchema.safeParse({
			rangedFilters: JSON.stringify([{ key: "dueDate", start: "2026-01-01" }]),
		});
		expect(result.success).toBe(false);
	});

	test("rejects an orderKey outside the allow-list", () => {
		const result = taskOfficialListQuerySchema.safeParse({
			orderKey: "deletedAt",
		});
		expect(result.success).toBe(false);
	});

	test("accepts an allow-listed orderKey and rule", () => {
		const parsed = taskOfficialListQuerySchema.parse({
			orderKey: "priority",
			orderRule: "asc",
		});
		expect(parsed.orderKey).toBe("priority");
		expect(parsed.orderRule).toBe("asc");
	});

	test("rejects rows above the maximum page size", () => {
		const result = taskOfficialListQuerySchema.safeParse({ rows: "500" });
		expect(result.success).toBe(false);
	});

	test("coerces page and rows from query strings", () => {
		const parsed = taskOfficialListQuerySchema.parse({ page: "3", rows: "5" });
		expect(parsed.page).toBe(3);
		expect(parsed.rows).toBe(5);
	});

	test("rejects filters that are not a JSON object", () => {
		const result = taskOfficialListQuerySchema.safeParse({
			filters: JSON.stringify(["status"]),
		});
		expect(result.success).toBe(false);
	});
});

describe("flat task params", () => {
	test("accepts a task id without a project id", () => {
		expect(
			flatTaskIdParamSchema.parse({
				taskId: "3f0a9d2c-6b1e-4a55-9f3d-2c7b5e1d9a04",
			}),
		).toEqual({ taskId: "3f0a9d2c-6b1e-4a55-9f3d-2c7b5e1d9a04" });
	});

	test("rejects a non-uuid task id", () => {
		expect(() => flatTaskIdParamSchema.parse({ taskId: "task-1" })).toThrow();
	});
});
