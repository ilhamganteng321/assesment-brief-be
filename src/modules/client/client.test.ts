import { describe, expect, test } from "bun:test";
import type {
	ProjectAuthorizationContext,
	TaskAuthorizationContext,
	UserContext,
} from "../authorization/authorization.types";
import { ClientReadOnlyError } from "./client.errors";
import {
	canAccessClientApi,
	canAccessClientProject,
	canViewClientAuditLogs,
	canViewClientDashboard,
	canViewClientTask,
} from "./client.policy";
import {
	clientProjectIdParamSchema,
	clientTaskIdParamSchema,
	clientTaskListQuerySchema,
} from "./client.schema";

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
const otherClient: UserContext = {
	id: "cl-2",
	role: "CLIENT",
	department: "CLIENT",
};

function project(memberIds: readonly string[]): ProjectAuthorizationContext {
	return {
		id: "9f8e7d6c-5b4a-4321-9876-0fedcba98765",
		status: "ACTIVE",
		memberships: memberIds.map((userId) => ({ userId })),
	};
}

function task(
	overrides: Partial<TaskAuthorizationContext> = {},
): TaskAuthorizationContext {
	return {
		id: "3c9a1e8a-6d5b-4f21-9c3f-8f0d1a2b3c4d",
		projectId: "9f8e7d6c-5b4a-4321-9876-0fedcba98765",
		status: "TODO",
		assignedToId: null,
		clientVisible: false,
		...overrides,
	};
}

describe("client schema", () => {
	test("task list query applies defaults", () => {
		const parsed = clientTaskListQuerySchema.parse({});
		expect(parsed).toEqual({
			page: 1,
			limit: 20,
			search: undefined,
			status: undefined,
		});
	});

	test("task list query coerces page and limit", () => {
		const parsed = clientTaskListQuerySchema.parse({ page: "2", limit: "10" });
		expect(parsed.page).toBe(2);
		expect(parsed.limit).toBe(10);
	});

	test("task list query accepts optional search and status", () => {
		const parsed = clientTaskListQuerySchema.parse({
			search: "dashboard",
			status: "DONE",
		});
		expect(parsed.search).toBe("dashboard");
		expect(parsed.status).toBe("DONE");
	});

	test("task list query rejects clientVisible and assignedToId filter parameters", () => {
		expect(() =>
			clientTaskListQuerySchema.parse({ clientVisible: "true" }),
		).toThrow();
		expect(() =>
			clientTaskListQuerySchema.parse({
				assignedToId: "a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d",
			}),
		).toThrow();
	});

	test("task list query rejects invalid values", () => {
		expect(() => clientTaskListQuerySchema.parse({ page: "0" })).toThrow();
		expect(() => clientTaskListQuerySchema.parse({ page: "abc" })).toThrow();
		expect(() => clientTaskListQuerySchema.parse({ limit: "0" })).toThrow();
		expect(() => clientTaskListQuerySchema.parse({ limit: "101" })).toThrow();
		expect(() =>
			clientTaskListQuerySchema.parse({ status: "STARTED" }),
		).toThrow();
	});

	test("project id params require a valid uuid", () => {
		expect(
			clientProjectIdParamSchema.parse({
				projectId: "9f8e7d6c-5b4a-4321-9876-0fedcba98765",
			}).projectId,
		).toBe("9f8e7d6c-5b4a-4321-9876-0fedcba98765");
		expect(() => clientProjectIdParamSchema.parse({})).toThrow();
		expect(() =>
			clientProjectIdParamSchema.parse({ projectId: "nope" }),
		).toThrow();
	});

	test("task id params require valid project and task ids", () => {
		expect(() =>
			clientTaskIdParamSchema.parse({ projectId: "nope", taskId: "also-nope" }),
		).toThrow();
		expect(() =>
			clientTaskIdParamSchema.parse({ projectId: "nope" }),
		).toThrow();
	});
});

describe("client policy", () => {
	test("only CLIENT can access the client API", () => {
		expect(canAccessClientApi(client)).toBe(true);
		expect(canAccessClientApi(pm)).toBe(false);
		expect(canAccessClientApi(internal)).toBe(false);
	});

	test("only CLIENT can view the client dashboard", () => {
		expect(canViewClientDashboard(client)).toBe(true);
		expect(canViewClientDashboard(pm)).toBe(false);
	});

	test("CLIENT can access their own project", () => {
		expect(canAccessClientProject(client, project(["cl-1"]))).toBe(true);
		expect(canAccessClientProject(client, project([]))).toBe(false);
		expect(canAccessClientProject(client, project(["cl-2"]))).toBe(false);
	});

	test("only CLIENT role can access a client project", () => {
		expect(canAccessClientProject(pm, project(["pm-1"]))).toBe(false);
		expect(canAccessClientProject(internal, project(["fe-1"]))).toBe(false);
	});

	test("CLIENT can view their own client-visible tasks", () => {
		expect(
			canViewClientTask({
				user: client,
				task: task({ clientVisible: true }),
				project: project(["cl-1"]),
			}),
		).toBe(true);
	});

	test("CLIENT cannot view hidden or cross-tenant tasks", () => {
		expect(
			canViewClientTask({
				user: client,
				task: task({ clientVisible: false }),
				project: project(["cl-1"]),
			}),
		).toBe(false);
		expect(
			canViewClientTask({
				user: otherClient,
				task: task({ clientVisible: true }),
				project: project(["cl-1"]),
			}),
		).toBe(false);
	});

	test("non-CLIENT roles cannot view client tasks", () => {
		expect(
			canViewClientTask({
				user: pm,
				task: task({ clientVisible: true }),
				project: project(["pm-1"]),
			}),
		).toBe(false);
	});

	test("CLIENT can never access audit logs", () => {
		expect(canViewClientAuditLogs(client)).toBe(false);
		expect(canViewClientAuditLogs(pm)).toBe(false);
		expect(canViewClientAuditLogs(internal)).toBe(false);
	});

	test("client API write attempts throw a read-only error", () => {
		const error = new ClientReadOnlyError();
		expect(error.status).toBe(403);
		expect(error.code).toBe("CLIENT_READ_ONLY");
	});
});
