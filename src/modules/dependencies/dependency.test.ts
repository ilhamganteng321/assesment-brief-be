import { describe, expect, test } from "bun:test";
import type {
	ProjectAuthorizationContext,
	TaskAuthorizationContext,
	UserContext,
} from "../authorization/authorization.types";
import {
	canCreateDependency,
	canDeleteDependency,
	canViewDependencies,
} from "./dependency.policy";
import {
	createDependencySchema,
	dependencyDeleteParamsSchema,
	dependentTaskParamsSchema,
} from "./dependency.schema";
import { canReachTask, type DependencyEdge } from "./dependency.service";

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

describe("dependency schema", () => {
	test("create accepts a valid dependency task id", () => {
		const parsed = createDependencySchema.parse({
			dependencyTaskId: "3c9a1e8a-6d5b-4f21-9c3f-8f0d1a2b3c4d",
		});
		expect(parsed).toEqual({
			dependencyTaskId: "3c9a1e8a-6d5b-4f21-9c3f-8f0d1a2b3c4d",
		});
	});

	test("create rejects a non-uuid dependency task id", () => {
		expect(() =>
			createDependencySchema.parse({ dependencyTaskId: "not-a-uuid" }),
		).toThrow();
		expect(() => createDependencySchema.parse({})).toThrow();
	});

	test("create rejects unknown fields", () => {
		expect(() =>
			createDependencySchema.parse({
				dependencyTaskId: "3c9a1e8a-6d5b-4f21-9c3f-8f0d1a2b3c4d",
				createdAt: "2026-01-01",
			}),
		).toThrow();
	});

	test("param schemas require uuids", () => {
		const parsed = dependentTaskParamsSchema.parse({
			projectId: "3c9a1e8a-6d5b-4f21-9c3f-8f0d1a2b3c4d",
			taskId: "4c9a1e8a-6d5b-4f21-9c3f-8f0d1a2b3c4d",
		});
		expect(parsed.taskId).toBe("4c9a1e8a-6d5b-4f21-9c3f-8f0d1a2b3c4d");
		expect(() =>
			dependentTaskParamsSchema.parse({ projectId: "a", taskId: "b" }),
		).toThrow();

		const del = dependencyDeleteParamsSchema.parse({
			projectId: "3c9a1e8a-6d5b-4f21-9c3f-8f0d1a2b3c4d",
			taskId: "4c9a1e8a-6d5b-4f21-9c3f-8f0d1a2b3c4d",
			dependencyTaskId: "5c9a1e8a-6d5b-4f21-9c3f-8f0d1a2b3c4d",
		});
		expect(del.dependencyTaskId).toBe("5c9a1e8a-6d5b-4f21-9c3f-8f0d1a2b3c4d");
	});
});

describe("dependency policy", () => {
	test("PM can view dependencies of any task", () => {
		expect(canViewDependencies(pm, task(), project([]))).toBe(true);
	});

	test("INTERNAL can view dependencies of tasks they can access", () => {
		expect(canViewDependencies(internal, task(), project(["fe-1"]))).toBe(true);
		expect(canViewDependencies(internal, task(), project([]))).toBe(false);
	});

	test("CLIENT can only view dependencies of client-visible tasks in their project", () => {
		expect(
			canViewDependencies(
				client,
				task({ clientVisible: true }),
				project(["cl-1"]),
			),
		).toBe(true);
		expect(
			canViewDependencies(
				client,
				task({ clientVisible: false }),
				project(["cl-1"]),
			),
		).toBe(false);
		expect(
			canViewDependencies(client, task({ clientVisible: true }), project([])),
		).toBe(false);
	});

	test("only PM can create dependencies", () => {
		expect(canCreateDependency(pm)).toBe(true);
		expect(canCreateDependency(internal)).toBe(false);
		expect(canCreateDependency(client)).toBe(false);
	});

	test("only PM can delete dependencies", () => {
		expect(canDeleteDependency(pm)).toBe(true);
		expect(canDeleteDependency(internal)).toBe(false);
		expect(canDeleteDependency(client)).toBe(false);
	});
});

describe("dependency graph traversal", () => {
	const uuidA = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
	const uuidB = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
	const uuidC = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
	const uuidD = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";

	function edge(
		dependentTaskId: string,
		dependencyTaskId: string,
	): DependencyEdge {
		return { dependentTaskId, dependencyTaskId };
	}

	test("a task always reaches itself (self edges are cycles at graph level)", () => {
		expect(canReachTask([], uuidB, uuidB)).toBe(true);
	});

	test("A depends on B, then attempting B depends on A is a cycle", () => {
		const edges = [edge(uuidA, uuidB)];
		expect(canReachTask(edges, uuidA, uuidB)).toBe(true);
		expect(canReachTask(edges, uuidB, uuidA)).toBe(false);
	});

	test("spec example: A->B, B->C, adding C->A is circular", () => {
		const edges = [edge(uuidA, uuidB), edge(uuidB, uuidC)];
		expect(canReachTask(edges, uuidA, uuidC)).toBe(true);
		expect(canReachTask(edges, uuidC, uuidA)).toBe(false);
	});

	test("reachability only follows the depends-on direction", () => {
		const edges = [edge(uuidA, uuidB), edge(uuidB, uuidC)];
		expect(canReachTask(edges, uuidA, uuidC)).toBe(true);
		expect(canReachTask(edges, uuidB, uuidA)).toBe(false);
		expect(canReachTask(edges, uuidC, uuidB)).toBe(false);
	});

	test("shared dependency closes a cycle through the apex", () => {
		const edges = [edge(uuidA, uuidB), edge(uuidC, uuidB), edge(uuidB, uuidD)];
		expect(canReachTask(edges, uuidA, uuidD)).toBe(true);
		expect(canReachTask(edges, uuidC, uuidD)).toBe(true);
		expect(canReachTask(edges, uuidD, uuidA)).toBe(false);
		expect(canReachTask(edges, uuidD, uuidC)).toBe(false);
	});

	test("unrelated tasks never reach each other", () => {
		const edges = [edge(uuidA, uuidB)];
		expect(canReachTask(edges, uuidB, uuidC)).toBe(false);
		expect(canReachTask(edges, uuidC, uuidA)).toBe(false);
	});

	test("traversal handles a diamond without infinite loops", () => {
		const edges = [
			edge(uuidB, uuidA),
			edge(uuidC, uuidA),
			edge(uuidD, uuidB),
			edge(uuidD, uuidC),
		];
		expect(canReachTask(edges, uuidD, uuidA)).toBe(true);
		expect(canReachTask(edges, uuidA, uuidD)).toBe(false);
	});
});
