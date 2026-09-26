import type { Models } from "../../prisma/contract";
import { db } from "../../prisma/db";
import type {
	ProjectAuthorizationContext,
	UserContext,
} from "../authorization/authorization.types";
import { ProjectNotFoundError } from "../projects/project.errors";
import { TaskNotFoundError } from "../tasks/task.errors";
import type { TaskRecord } from "../tasks/task.types";
import {
	CircularDependencyError,
	CrossProjectDependencyError,
	DependencyAccessDeniedError,
	DependencyAlreadyExistsError,
	DependencyNotFoundError,
	SelfDependencyError,
} from "./dependency.errors";
import {
	canCreateDependency,
	canDeleteDependency,
	canViewDependencies,
} from "./dependency.policy";
import { createDependencySchema } from "./dependency.schema";
import type {
	DependencyTaskSummary,
	TaskBlockingState,
	TaskDependencyRecord,
} from "./dependency.types";

type ProjectRow = Omit<Models.public_Projects, "members" | "tasks">;

type TaskSummaryRow = Pick<
	TaskRecord,
	"id" | "title" | "status" | "clientVisible"
>;

export type DependencyEdge = {
	dependentTaskId: string;
	dependencyTaskId: string;
};

export type BlockingStateOptions = {
	visibleOnly?: boolean;
};

async function requireVisibleProject(projectId: string): Promise<ProjectRow> {
	const project = await db.orm.public.Projects.where((row) =>
		row.id.eq(projectId),
	)
		.where((row) => row.deletedAt.isNull())
		.first();
	if (!project) {
		throw new ProjectNotFoundError();
	}
	return project;
}

async function loadMemberIds(projectId: string): Promise<string[]> {
	const members = await db.orm.public.ProjectMembers.where((member) =>
		member.projectId.eq(projectId),
	)
		.select("userId")
		.all();
	return members.map((member) => member.userId);
}

function toProjectContext(
	project: Pick<ProjectRow, "id" | "status">,
	memberIds: readonly string[],
): ProjectAuthorizationContext {
	return {
		id: project.id,
		status: project.status,
		memberships: memberIds.map((userId) => ({ userId })),
	};
}

async function loadProjectTasks(projectId: string): Promise<TaskSummaryRow[]> {
	return db.orm.public.Tasks.where((task) => task.projectId.eq(projectId))
		.where((task) => task.deletedAt.isNull())
		.select("id", "title", "status", "clientVisible")
		.all();
}

async function loadGraph(
	projectId: string,
): Promise<{ tasks: TaskSummaryRow[]; edges: DependencyEdge[] }> {
	const tasks = await loadProjectTasks(projectId);
	const projectTaskIds = tasks.map((task) => task.id);
	if (projectTaskIds.length === 0) {
		return { tasks, edges: [] };
	}

	const taskIds = new Set(projectTaskIds);
	const rows = await db.orm.public.TaskDependencies.where((row) =>
		row.dependentTaskId.in(projectTaskIds),
	)
		.select("dependentTaskId", "dependencyTaskId")
		.all();

	const edges: DependencyEdge[] = [];
	for (const row of rows) {
		if (!taskIds.has(row.dependencyTaskId)) {
			continue;
		}
		edges.push({
			dependentTaskId: row.dependentTaskId,
			dependencyTaskId: row.dependencyTaskId,
		});
	}

	return { tasks, edges };
}

export function canReachTask(
	edges: readonly DependencyEdge[],
	startTaskId: string,
	targetTaskId: string,
): boolean {
	const outgoing = new Map<string, string[]>();
	for (const edge of edges) {
		const list = outgoing.get(edge.dependentTaskId);
		if (list === undefined) {
			outgoing.set(edge.dependentTaskId, [edge.dependencyTaskId]);
		} else {
			list.push(edge.dependencyTaskId);
		}
	}

	const visited = new Set<string>();
	const stack = [startTaskId];
	while (stack.length > 0) {
		const current = stack.pop();
		if (current === undefined) {
			break;
		}
		if (current === targetTaskId) {
			return true;
		}
		if (visited.has(current)) {
			continue;
		}
		visited.add(current);
		const next = outgoing.get(current);
		if (next !== undefined) {
			for (const node of next) {
				if (!visited.has(node)) {
					stack.push(node);
				}
			}
		}
	}
	return false;
}

export async function hasCircularDependency(
	projectId: string,
	taskId: string,
	dependencyTaskId: string,
): Promise<boolean> {
	const { edges } = await loadGraph(projectId);
	return canReachTask(edges, dependencyTaskId, taskId);
}

export async function computeTaskBlockingStates(
	projectId: string,
	taskIds: readonly string[],
	options: BlockingStateOptions = {},
): Promise<Map<string, TaskBlockingState>> {
	const { tasks, edges } = await loadGraph(projectId);
	const taskById = new Map(tasks.map((task) => [task.id, task]));
	const states = new Map<string, TaskBlockingState>();

	for (const taskId of taskIds) {
		const blockedBy: DependencyTaskSummary[] = [];
		for (const edge of edges) {
			if (edge.dependentTaskId !== taskId) {
				continue;
			}
			const dependencyTask = taskById.get(edge.dependencyTaskId);
			if (dependencyTask === undefined) {
				continue;
			}
			if (options.visibleOnly && !dependencyTask.clientVisible) {
				continue;
			}
			if (dependencyTask.status !== "DONE") {
				blockedBy.push({
					id: dependencyTask.id,
					title: dependencyTask.title,
					status: dependencyTask.status,
				});
			}
		}
		states.set(taskId, { blocked: blockedBy.length > 0, blockedBy });
	}

	return states;
}

export async function getTaskBlockingState(
	projectId: string,
	taskId: string,
	options: BlockingStateOptions = {},
): Promise<TaskBlockingState> {
	const states = await computeTaskBlockingStates(projectId, [taskId], options);
	return states.get(taskId) ?? { blocked: false, blockedBy: [] };
}

export async function getBlockingDependencies(
	projectId: string,
	taskId: string,
): Promise<DependencyTaskSummary[]> {
	const state = await getTaskBlockingState(projectId, taskId);
	return state.blockedBy;
}

export async function areDependenciesCompleted(
	projectId: string,
	taskId: string,
): Promise<boolean> {
	const state = await getTaskBlockingState(projectId, taskId);
	return !state.blocked;
}

export async function getDependents(
	projectId: string,
	taskId: string,
): Promise<DependencyTaskSummary[]> {
	const { tasks, edges } = await loadGraph(projectId);
	const taskById = new Map(tasks.map((task) => [task.id, task]));
	const dependents: DependencyTaskSummary[] = [];

	for (const edge of edges) {
		if (edge.dependencyTaskId !== taskId) {
			continue;
		}
		const dependent = taskById.get(edge.dependentTaskId);
		if (dependent === undefined) {
			continue;
		}
		dependents.push({
			id: dependent.id,
			title: dependent.title,
			status: dependent.status,
		});
	}

	return dependents;
}

async function assertTaskInProject(
	projectId: string,
	taskId: string,
): Promise<void> {
	const task = await db.orm.public.Tasks.first({ id: taskId });
	if (!task || task.deletedAt !== null) {
		throw new TaskNotFoundError();
	}
	if (task.projectId !== projectId) {
		throw new CrossProjectDependencyError();
	}
}

export async function listDependencies(
	user: UserContext,
	projectId: string,
	taskId: string,
): Promise<DependencyTaskSummary[]> {
	const project = await requireVisibleProject(projectId);
	const memberIds = await loadMemberIds(project.id);
	const projectContext = toProjectContext(project, memberIds);

	const dependent = await db.orm.public.Tasks.where((row) => row.id.eq(taskId))
		.where((row) => row.projectId.eq(project.id))
		.where((row) => row.deletedAt.isNull())
		.first();
	if (!dependent) {
		throw new TaskNotFoundError();
	}

	if (!canViewDependencies(user, dependent, projectContext)) {
		throw new DependencyAccessDeniedError(
			"You do not have permission to view task dependencies",
		);
	}

	const visibleOnly = user.role === "CLIENT";
	const { tasks, edges } = await loadGraph(project.id);
	const taskById = new Map(tasks.map((task) => [task.id, task]));
	const dependencies: DependencyTaskSummary[] = [];

	for (const edge of edges) {
		if (edge.dependentTaskId !== taskId) {
			continue;
		}
		const dependencyTask = taskById.get(edge.dependencyTaskId);
		if (dependencyTask === undefined) {
			continue;
		}
		if (visibleOnly && !dependencyTask.clientVisible) {
			continue;
		}
		dependencies.push({
			id: dependencyTask.id,
			title: dependencyTask.title,
			status: dependencyTask.status,
		});
	}

	return dependencies;
}

export async function createDependency(
	user: UserContext,
	projectId: string,
	taskId: string,
	rawInput: unknown,
): Promise<TaskDependencyRecord> {
	if (!canCreateDependency(user)) {
		throw new DependencyAccessDeniedError(
			"You do not have permission to create task dependencies",
		);
	}

	const input = createDependencySchema.parse(rawInput);
	const dependencyTaskId = input.dependencyTaskId;

	if (dependencyTaskId === taskId) {
		throw new SelfDependencyError();
	}

	const project = await requireVisibleProject(projectId);
	await assertTaskInProject(project.id, taskId);
	await assertTaskInProject(project.id, dependencyTaskId);

	return db.transaction(async (tx) => {
		const existing = await tx.orm.public.TaskDependencies.where((row) =>
			row.dependentTaskId.eq(taskId),
		)
			.where((row) => row.dependencyTaskId.eq(dependencyTaskId))
			.first();
		if (existing) {
			throw new DependencyAlreadyExistsError();
		}

		if (await hasCircularDependency(project.id, taskId, dependencyTaskId)) {
			throw new CircularDependencyError();
		}

		return tx.orm.public.TaskDependencies.create({
			dependentTaskId: taskId,
			dependencyTaskId,
		});
	});
}

export async function removeDependency(
	user: UserContext,
	projectId: string,
	taskId: string,
	dependencyTaskId: string,
): Promise<void> {
	if (!canDeleteDependency(user)) {
		throw new DependencyAccessDeniedError(
			"You do not have permission to delete task dependencies",
		);
	}

	const project = await requireVisibleProject(projectId);

	const dependent = await db.orm.public.Tasks.where((row) => row.id.eq(taskId))
		.where((row) => row.projectId.eq(project.id))
		.where((row) => row.deletedAt.isNull())
		.first();
	if (!dependent) {
		throw new TaskNotFoundError();
	}

	const existing = await db.orm.public.TaskDependencies.where((row) =>
		row.dependentTaskId.eq(taskId),
	)
		.where((row) => row.dependencyTaskId.eq(dependencyTaskId))
		.first();
	if (!existing) {
		throw new DependencyNotFoundError();
	}

	await db.orm.public.TaskDependencies.where((row) =>
		row.id.eq(existing.id),
	).delete();
}
