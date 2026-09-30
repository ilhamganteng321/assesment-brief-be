import type { Models } from "../../prisma/contract";
import { db } from "../../prisma/db";
import type {
	ProjectAuthorizationContext,
	TaskStatus,
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
	CanStartTaskResult,
	DependencyTaskSummary,
	TaskBlockingState,
	TaskDependencyRecord,
} from "./dependency.types";

type ProjectRow = Omit<
	Models.public_Projects,
	"members" | "tasks" | "invitations"
>;

/**
 * The only task fields the dependency graph needs. Narrower than `TaskRecord`
 * on purpose: the traversal must never grow a dependency on assignee, priority,
 * or any other column that has no business in a graph calculation.
 */
export type DependencyGraphTask = {
	id: string;
	title: string;
	status: TaskStatus;
	clientVisible: boolean;
	deletedAt: TaskRecord["deletedAt"];
};

type TaskSummaryRow = DependencyGraphTask & { id: TaskRecord["id"] };

export type DependencyEdge = {
	dependentTaskId: string;
	dependencyTaskId: string;
};

export type BlockingStateOptions = {
	visibleOnly?: boolean;
};

type DependencyGraph = {
	tasks: TaskSummaryRow[];
	edges: DependencyEdge[];
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

/**
 * Loads every task of the project, soft deleted ones included.
 *
 * A dependency edge outlives the task it points at because tasks are soft
 * deleted, so the graph has to keep those rows to stay accurate. Callers decide
 * per audience whether a deleted prerequisite may be shown.
 */
async function loadProjectTasks(projectId: string): Promise<TaskSummaryRow[]> {
	return db.orm.public.Tasks.where((task) => task.projectId.eq(projectId))
		.select("id", "title", "status", "clientVisible", "deletedAt")
		.all();
}

function isDeleted(task: TaskSummaryRow): boolean {
	return task.deletedAt !== null;
}

function toSummary(task: TaskSummaryRow): DependencyTaskSummary {
	return {
		id: task.id,
		title: task.title,
		status: task.status,
		deleted: isDeleted(task),
	};
}

async function loadGraph(projectId: string): Promise<DependencyGraph> {
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

/**
 * Pure core of the blocking rule: a task is blocked while at least one
 * prerequisite is not DONE.
 *
 * Kept free of I/O so the rule itself can be tested directly, and so the list,
 * the detail view, and the transition guard cannot drift apart. A soft deleted
 * prerequisite is not DONE either, so deleting a prerequisite never silently
 * releases its dependents; a client guest additionally sees neither internal nor
 * deleted prerequisites.
 */
export function computeBlockingState(
	taskId: string,
	tasks: readonly TaskSummaryRow[],
	edges: readonly DependencyEdge[],
	options: BlockingStateOptions = {},
): TaskBlockingState {
	const taskById = new Map(tasks.map((task) => [task.id, task]));
	const blockedBy: DependencyTaskSummary[] = [];

	for (const edge of edges) {
		if (edge.dependentTaskId !== taskId) {
			continue;
		}
		const prerequisite = taskById.get(edge.dependencyTaskId);
		if (prerequisite === undefined) {
			continue;
		}
		if (
			options.visibleOnly &&
			(!prerequisite.clientVisible || isDeleted(prerequisite))
		) {
			continue;
		}
		if (prerequisite.status !== "DONE") {
			blockedBy.push(toSummary(prerequisite));
		}
	}

	return { blocked: blockedBy.length > 0, blockedBy };
}

export async function computeTaskBlockingStates(
	projectId: string,
	taskIds: readonly string[],
	options: BlockingStateOptions = {},
): Promise<Map<string, TaskBlockingState>> {
	const { tasks, edges } = await loadGraph(projectId);
	const states = new Map<string, TaskBlockingState>();

	for (const taskId of taskIds) {
		states.set(taskId, computeBlockingState(taskId, tasks, edges, options));
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

/**
 * The single reusable dependency check. Status transitions, the board, and the
 * detail view all ask this question so the answer can never drift.
 */
export async function checkCanStartTask(
	projectId: string,
	taskId: string,
	options: BlockingStateOptions = {},
): Promise<CanStartTaskResult> {
	const blocking = await getTaskBlockingState(projectId, taskId, options);
	return { allowed: !blocking.blocked, blockingTasks: blocking.blockedBy };
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
		if (dependent === undefined || isDeleted(dependent)) {
			continue;
		}
		dependents.push(toSummary(dependent));
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
	// Dependency reads belong to the internal surface, like the task reads they
	// hang off. A client guest who is a member of the project would otherwise
	// pass the check below and receive prerequisite titles and statuses from a
	// route the client portal does not expose. The portal already shows every
	// client-visible task, so nothing is lost by keeping this closed.
	if (user.role === "CLIENT") {
		throw new DependencyAccessDeniedError(
			"Task dependencies are only available to internal team members",
		);
	}

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
		// A soft deleted prerequisite is still listed, flagged `deleted`, because
		// the edge survives the task and hiding it would make the graph look
		// resolvable when it is not.
		dependencies.push(toSummary(dependencyTask));
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
			createdBy: user.id,
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

/**
 * Resolves the owning project of a task for the flat dependency surface.
 *
 * `GET /tasks/:taskId/dependencies` carries no project id, so the project is
 * derived from the task itself and the task must exist. Authorization is not
 * decided here: the nested implementations below apply the ABAC rules, which
 * means the flat surface can never be more permissive than the nested one.
 */
async function requireLiveTask(taskId: string): Promise<TaskRecord> {
	const task = await db.orm.public.Tasks.where((row) => row.id.eq(taskId))
		.where((row) => row.deletedAt.isNull())
		.first();
	if (!task) {
		throw new TaskNotFoundError();
	}
	return task;
}

export async function listDependenciesForTask(
	user: UserContext,
	taskId: string,
): Promise<DependencyTaskSummary[]> {
	const task = await requireLiveTask(taskId);
	return listDependencies(user, task.projectId, task.id);
}

export async function createDependencyForTask(
	user: UserContext,
	taskId: string,
	rawInput: unknown,
): Promise<TaskDependencyRecord> {
	const task = await requireLiveTask(taskId);
	return createDependency(user, task.projectId, task.id, rawInput);
}

export async function removeDependencyForTask(
	user: UserContext,
	taskId: string,
	dependencyTaskId: string,
): Promise<void> {
	const task = await requireLiveTask(taskId);
	return removeDependency(user, task.projectId, task.id, dependencyTaskId);
}
