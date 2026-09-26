import { describe, expect, test } from "bun:test";
import type {
	ProjectAuthorizationContext,
	UserContext,
} from "../authorization/authorization.types";
import { canViewTaskAuditLogs } from "./audit.policy";
import { AUDITABLE_COLUMNS, auditListQuerySchema } from "./audit.schema";
import { buildAuditEntries, serializeAuditValue } from "./audit.service";
import type { TaskAuditSnapshot } from "./audit.types";

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

const TASK_ID = "3c9a1e8a-6d5b-4f21-9c3f-8f0d1a2b3c4d";
const USER_ID = "a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d";

function project(memberIds: readonly string[]): ProjectAuthorizationContext {
	return {
		id: "9f8e7d6c-5b4a-4321-9876-0fedcba98765",
		status: "ACTIVE",
		memberships: memberIds.map((userId) => ({ userId })),
	};
}

function snapshot(
	overrides: Partial<TaskAuditSnapshot> = {},
): TaskAuditSnapshot {
	return {
		title: "Build dashboard",
		description: null,
		assignedToId: null,
		status: "TODO",
		priority: "MEDIUM",
		department: "PRODUCT",
		clientVisible: false,
		deletedAt: null,
		...overrides,
	};
}

describe("audit schema", () => {
	test("enumerates exactly the auditable columns", () => {
		expect(AUDITABLE_COLUMNS).toEqual([
			"title",
			"description",
			"assignedToId",
			"status",
			"priority",
			"department",
			"clientVisible",
			"deletedAt",
		]);
	});

	test("excludes purely technical columns from the audit trail", () => {
		// `version` and `updatedAt` move on every successful write, so recording
		// them would bury the real history; neither is a user-facing action.
		expect(AUDITABLE_COLUMNS).not.toContain("version");
		expect(AUDITABLE_COLUMNS).not.toContain("updatedAt");
		expect(AUDITABLE_COLUMNS).not.toContain("createdAt");
		expect(AUDITABLE_COLUMNS).not.toContain("id");
		expect(AUDITABLE_COLUMNS).not.toContain("projectId");
	});

	test("list query applies defaults", () => {
		const parsed = auditListQuerySchema.parse({});
		expect(parsed).toEqual({ page: 1, limit: 20, changedColumn: undefined });
	});

	test("list query coerces page and limit", () => {
		const parsed = auditListQuerySchema.parse({ page: "3", limit: "50" });
		expect(parsed.page).toBe(3);
		expect(parsed.limit).toBe(50);
	});

	test("list query accepts every auditable changedColumn", () => {
		for (const column of AUDITABLE_COLUMNS) {
			expect(
				auditListQuerySchema.parse({ changedColumn: column }).changedColumn,
			).toBe(column);
		}
	});

	test("list query rejects non-auditable changedColumn values", () => {
		expect(() =>
			auditListQuerySchema.parse({ changedColumn: "version" }),
		).toThrow();
		expect(() => auditListQuerySchema.parse({ changedColumn: "id" })).toThrow();
		expect(() =>
			auditListQuerySchema.parse({ changedColumn: "createdAt" }),
		).toThrow();
	});

	test("list query rejects invalid pages and limits", () => {
		expect(() => auditListQuerySchema.parse({ page: "0" })).toThrow();
		expect(() => auditListQuerySchema.parse({ page: "abc" })).toThrow();
		expect(() => auditListQuerySchema.parse({ limit: "0" })).toThrow();
		expect(() => auditListQuerySchema.parse({ limit: "101" })).toThrow();
	});
});

describe("serializeAuditValue", () => {
	test("keeps strings as-is", () => {
		expect(serializeAuditValue("IN_PROGRESS")).toBe("IN_PROGRESS");
		expect(serializeAuditValue("Build dashboard")).toBe("Build dashboard");
	});

	test("serializes booleans", () => {
		expect(serializeAuditValue(true)).toBe("true");
		expect(serializeAuditValue(false)).toBe("false");
	});

	test("serializes numbers", () => {
		expect(serializeAuditValue(42)).toBe("42");
	});

	test("serializes objects via toString", () => {
		expect(serializeAuditValue({ toString: () => "2026-09-25T10:00:00" })).toBe(
			"2026-09-25T10:00:00",
		);
	});

	test("serializes null and undefined to null", () => {
		expect(serializeAuditValue(null)).toBeNull();
		expect(serializeAuditValue(undefined)).toBeNull();
	});
});

describe("buildAuditEntries", () => {
	test("records a single changed column", () => {
		const entries = buildAuditEntries({
			taskId: TASK_ID,
			userId: USER_ID,
			before: snapshot(),
			after: snapshot({ title: "Build admin panel" }),
		});

		expect(entries).toEqual([
			{
				taskId: TASK_ID,
				userId: USER_ID,
				changedColumn: "title",
				oldValue: "Build dashboard",
				newValue: "Build admin panel",
			},
		]);
	});

	test("records every changed field without a version record", () => {
		const entries = buildAuditEntries({
			taskId: TASK_ID,
			userId: USER_ID,
			before: snapshot(),
			after: snapshot({
				title: "Build admin panel",
				description: "Create the API",
				status: "IN_PROGRESS",
				priority: "URGENT",
				department: "BACKEND",
				clientVisible: true,
			}),
		});

		expect(entries.map((entry) => entry.changedColumn)).toEqual([
			"title",
			"description",
			"status",
			"priority",
			"department",
			"clientVisible",
		]);
		expect(
			entries.some((entry) => (entry.changedColumn as string) === "version"),
		).toBe(false);
	});

	test("gives every field its own record with its own old and new value", () => {
		const entries = buildAuditEntries({
			taskId: TASK_ID,
			userId: USER_ID,
			before: snapshot(),
			after: snapshot({
				title: "Build admin panel",
				description: "Create the API",
				priority: "HIGH",
			}),
		});

		expect(entries).toEqual([
			{
				taskId: TASK_ID,
				userId: USER_ID,
				changedColumn: "title",
				oldValue: "Build dashboard",
				newValue: "Build admin panel",
			},
			{
				taskId: TASK_ID,
				userId: USER_ID,
				changedColumn: "description",
				oldValue: null,
				newValue: "Create the API",
			},
			{
				taskId: TASK_ID,
				userId: USER_ID,
				changedColumn: "priority",
				oldValue: "MEDIUM",
				newValue: "HIGH",
			},
		]);
	});

	test("records a priority change on its own", () => {
		const entries = buildAuditEntries({
			taskId: TASK_ID,
			userId: USER_ID,
			before: snapshot(),
			after: snapshot({ priority: "LOW" }),
		});

		expect(entries).toEqual([
			{
				taskId: TASK_ID,
				userId: USER_ID,
				changedColumn: "priority",
				oldValue: "MEDIUM",
				newValue: "LOW",
			},
		]);
	});

	test("records a department change on its own", () => {
		const entries = buildAuditEntries({
			taskId: TASK_ID,
			userId: USER_ID,
			before: snapshot(),
			after: snapshot({ department: "FRONTEND" }),
		});

		expect(entries).toEqual([
			{
				taskId: TASK_ID,
				userId: USER_ID,
				changedColumn: "department",
				oldValue: "PRODUCT",
				newValue: "FRONTEND",
			},
		]);
	});

	test("does not create entries for unchanged values", () => {
		const entries = buildAuditEntries({
			taskId: TASK_ID,
			userId: USER_ID,
			before: snapshot(),
			after: snapshot(),
		});

		expect(entries).toEqual([]);
	});

	test("treats a no-op field value as unchanged", () => {
		const entries = buildAuditEntries({
			taskId: TASK_ID,
			userId: USER_ID,
			before: snapshot({ title: "Build dashboard" }),
			after: snapshot({ title: "Build dashboard", status: "TODO" }),
		});

		expect(entries).toEqual([]);
	});

	test("records setting a null field to a value", () => {
		const entries = buildAuditEntries({
			taskId: TASK_ID,
			userId: USER_ID,
			before: snapshot(),
			after: snapshot({ description: "Create the API" }),
		});

		expect(entries).toEqual([
			{
				taskId: TASK_ID,
				userId: USER_ID,
				changedColumn: "description",
				oldValue: null,
				newValue: "Create the API",
			},
		]);
	});

	test("records clearing a value field to null", () => {
		const entries = buildAuditEntries({
			taskId: TASK_ID,
			userId: USER_ID,
			before: snapshot({ description: "Create the API" }),
			after: snapshot(),
		});

		expect(entries).toEqual([
			{
				taskId: TASK_ID,
				userId: USER_ID,
				changedColumn: "description",
				oldValue: "Create the API",
				newValue: null,
			},
		]);
	});

	test("records assignment changes using user ids only", () => {
		const entries = buildAuditEntries({
			taskId: TASK_ID,
			userId: USER_ID,
			before: snapshot({
				assignedToId: "a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d",
			}),
			after: snapshot({ assignedToId: "f5e4d3c2-b1a0-4f2e-9d8c-7b6a5f4e3d2c" }),
		});

		expect(entries).toEqual([
			{
				taskId: TASK_ID,
				userId: USER_ID,
				changedColumn: "assignedToId",
				oldValue: "a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d",
				newValue: "f5e4d3c2-b1a0-4f2e-9d8c-7b6a5f4e3d2c",
			},
		]);
	});

	test("serializes boolean visibility changes", () => {
		const entries = buildAuditEntries({
			taskId: TASK_ID,
			userId: USER_ID,
			before: snapshot(),
			after: snapshot({ clientVisible: true }),
		});

		expect(entries).toEqual([
			{
				taskId: TASK_ID,
				userId: USER_ID,
				changedColumn: "clientVisible",
				oldValue: "false",
				newValue: "true",
			},
		]);
	});

	test("records deletion timestamps", () => {
		const deletedAt = { toString: () => "2026-09-25T10:00:00Z" };
		const entries = buildAuditEntries({
			taskId: TASK_ID,
			userId: USER_ID,
			before: { ...snapshot(), deletedAt: null } as TaskAuditSnapshot,
			after: { ...snapshot(), deletedAt },
		});

		expect(entries).toEqual([
			{
				taskId: TASK_ID,
				userId: USER_ID,
				changedColumn: "deletedAt",
				oldValue: null,
				newValue: "2026-09-25T10:00:00Z",
			},
		]);
	});
});

describe("audit policy", () => {
	test("PM can always view task audit logs", () => {
		expect(canViewTaskAuditLogs(pm, project([]))).toBe(true);
	});

	test("INTERNAL can view audit logs for projects they belong to", () => {
		expect(canViewTaskAuditLogs(internal, project(["fe-1"]))).toBe(true);
		expect(canViewTaskAuditLogs(internal, project([]))).toBe(false);
	});

	test("CLIENT cannot view task audit logs even for their own project", () => {
		expect(canViewTaskAuditLogs(client, project(["cl-1"]))).toBe(false);
	});
});
