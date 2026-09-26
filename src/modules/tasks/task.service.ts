import { param } from "@prisma/orm-family-sql/relational-core/expression";
import type { Models } from "../../prisma/contract";
import { db } from "../../prisma/db";
import {
	nowTimestamp,
	type TimestampValue,
	toTimestamp,
	toVarchar,
} from "../../prisma/scalars";
import { buildAuditEntries, createAuditLogs } from "../audit/audit.service";
import type {
	ProjectAuthorizationContext,
	UserContext,
} from "../authorization/authorization.types";
import { computeTaskBlockingStates } from "../dependencies/dependency.service";
import type { TaskBlockingState } from "../dependencies/dependency.types";
import {
	ProjectNotFoundError,
	ProjectUserNotFoundError,
} from "../projects/project.errors";
import { toTaskDetailResponse, toTaskResponse } from "./task.dto";
import {
	TaskAccessDeniedError,
	TaskAlreadyDeletedError,
	TaskAssigneeNotEligibleError,
	TaskAssigneeNotMemberError,
	TaskDepartmentMismatchError,
	TaskNotFoundError,
	TaskVersionConflictError,
} from "./task.errors";
import {
	canAccessProjectTasks,
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
	TASK_DEPARTMENTS,
	updateTaskSchema,
} from "./task.schema";
import type {
	Pagination,
	TaskAssigneeRow,
	TaskDepartment,
	TaskDetailResponse,
	TaskListQuery,
	TaskListResponse,
	TaskOfficialListQueryInput,
	TaskPriority,
	TaskResponse,
} from "./task.types";
import { validateStatusTransition } from "./task-state.service";

const DEFAULT_TASK_DEPARTMENT: TaskDepartment = "PRODUCT";
const DEFAULT_TASK_PRIORITY: TaskPriority = "MEDIUM";

function toPagination(page: number, limit: number, total: number): Pagination {
	return {
		page,
		limit,
		total,
		totalPages: Math.ceil(total / limit),
	};
}

/**
 * The flat `/tasks` surface is internal-only. Clients keep using the sanitized
 * `/client` routes, so a client never reaches a task row through here.
 */
function assertInternalTaskApiAccess(user: UserContext): void {
	if (user.role === "CLIENT") {
		throw new TaskAccessDeniedError(
			"This task data is only available to internal team members",
		);
	}
}

/**
 * `null` means unscoped (a PM may see every project); an array is the hard set of
 * project ids the caller may read, and it is applied inside the query rather
 * than filtered afterwards.
 */
async function resolveTaskAccessScope(
	user: UserContext,
): Promise<string[] | null> {
	if (user.role === "PM") {
		return null;
	}

	const memberships = await db.orm.public.ProjectMembers.where((member) =>
		member.userId.eq(user.id),
	)
		.select("projectId")
		.all();

	return memberships.map((membership) => membership.projectId);
}

async function loadUserDepartment(
	userId: string,
): Promise<TaskDepartment | null> {
	const target = await db.orm.public.Users.first({ id: userId });
	if (target === null) {
		return null;
	}
	return toTaskDepartment(target.department);
}

/**
 * A stored department always narrows to a task-owning department. `CLIENT` is
 * never accepted on input, so a row can only carry it if it was written outside
 * the API; it is treated as unowned rather than being surfaced as a task team.
 */
function toTaskDepartment(value: string): TaskDepartment {
	return TASK_DEPARTMENTS.includes(value as TaskDepartment)
		? (value as TaskDepartment)
		: DEFAULT_TASK_DEPARTMENT;
}

function escapeLikePattern(value: string): string {
	return value.replace(/[\\%_]/g, "\\$&");
}

const EMPTY_BLOCKING_STATE: TaskBlockingState = {
	blocked: false,
	blockedBy: [],
};

type ProjectRow = Omit<Models.public_Projects, "members" | "tasks">;

async function findVisibleProject(
	projectId: string,
): Promise<ProjectRow | null> {
	return db.orm.public.Projects.where((project) => project.id.eq(projectId))
		.where((project) => project.deletedAt.isNull())
		.first();
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

async function getBlockingState(
	projectId: string,
	taskId: string,
	visibleOnly: boolean,
): Promise<TaskBlockingState> {
	const states = await computeTaskBlockingStates(projectId, [taskId], {
		visibleOnly,
	});
	return states.get(taskId) ?? EMPTY_BLOCKING_STATE;
}

async function assertValidAssignee(
	projectId: string,
	userId: string,
	taskDepartment: TaskDepartment,
): Promise<TaskAssigneeRow> {
	const target = await db.orm.public.Users.first({ id: userId });
	if (!target) {
		throw new ProjectUserNotFoundError();
	}

	const membership = await db.orm.public.ProjectMembers.where((member) =>
		member.projectId.eq(projectId),
	)
		.where((member) => member.userId.eq(userId))
		.first();
	if (!membership) {
		throw new TaskAssigneeNotMemberError();
	}

	if (target.role === "CLIENT") {
		throw new TaskAssigneeNotEligibleError();
	}

	// A task is owned by exactly one department, so the person doing the work and
	// the team accountable for it can never disagree.
	if (target.department !== taskDepartment) {
		throw new TaskDepartmentMismatchError(target.department, taskDepartment);
	}

	return {
		id: target.id,
		name: target.name,
		email: target.email,
		department: target.department,
	};
}

export async function listTasks(
	user: UserContext,
	projectId: string,
	query: TaskListQuery,
): Promise<TaskListResponse> {
	const project = await findVisibleProject(projectId);
	if (!project) {
		throw new ProjectNotFoundError();
	}

	const memberIds = await loadMemberIds(project.id);
	if (!canAccessProjectTasks(user, toProjectContext(project, memberIds))) {
		throw new TaskAccessDeniedError(
			"You do not have permission to access tasks in this project",
		);
	}

	const page = query.page;
	const limit = query.limit;
	const status = query.status;
	const assignedToId = query.assignedToId;
	const queryClientVisible = query.clientVisible;
	const search =
		query.search === undefined || query.search.length === 0
			? undefined
			: query.search;
	const clientVisible = user.role === "CLIENT" ? true : queryClientVisible;

	let collection = db.orm.public.Tasks.where((task) =>
		task.projectId.eq(project.id),
	).where((task) => task.deletedAt.isNull());

	if (status !== undefined) {
		collection = collection.where((task) => task.status.eq(status));
	}
	if (assignedToId !== undefined) {
		collection = collection.where((task) => task.assignedToId.eq(assignedToId));
	}
	if (clientVisible !== undefined) {
		collection = collection.where((task) =>
			task.clientVisible.eq(clientVisible),
		);
	}
	if (search !== undefined) {
		collection = collection.where((task) =>
			task.title.ilike(`%${escapeLikePattern(search)}%`),
		);
	}

	const countResult = await collection.aggregate((aggregate) => ({
		total: aggregate.count(),
	}));
	const tasks = await collection
		.orderBy((task) => task.createdAt.desc())
		.limit(limit)
		.offset((page - 1) * limit)
		.all();

	const visibleOnly = user.role === "CLIENT";
	const blockingStates = await computeTaskBlockingStates(
		project.id,
		tasks.map((task) => task.id),
		{ visibleOnly },
	);

	return {
		tasks: tasks.map((task) =>
			toTaskResponse(task, blockingStates.get(task.id) ?? EMPTY_BLOCKING_STATE),
		),
		pagination: {
			page,
			limit,
			total: countResult.total,
			totalPages: Math.ceil(countResult.total / limit),
		},
	};
}

export async function getTask(
	user: UserContext,
	projectId: string,
	taskId: string,
): Promise<TaskResponse> {
	const project = await findVisibleProject(projectId);
	if (!project) {
		throw new ProjectNotFoundError();
	}

	const memberIds = await loadMemberIds(project.id);
	const projectContext = toProjectContext(project, memberIds);

	const task = await db.orm.public.Tasks.where((row) => row.id.eq(taskId))
		.where((row) => row.projectId.eq(project.id))
		.where((row) => row.deletedAt.isNull())
		.first();
	if (!task) {
		throw new TaskNotFoundError();
	}

	if (!canViewTask(user, task, projectContext)) {
		throw new TaskAccessDeniedError();
	}

	const blocking = await getBlockingState(
		project.id,
		task.id,
		user.role === "CLIENT",
	);
	return toTaskResponse(task, blocking);
}

export async function createTask(
	user: UserContext,
	projectId: string,
	rawInput: unknown,
): Promise<TaskResponse> {
	if (!canCreateTask(user)) {
		throw new TaskAccessDeniedError(
			"You do not have permission to create tasks",
		);
	}

	const input = createTaskSchema.parse(rawInput);

	const project = await findVisibleProject(projectId);
	if (!project) {
		throw new ProjectNotFoundError();
	}

	// An explicit department wins; otherwise the assignee's own department is
	// inferred so assignment and ownership can never drift apart.
	const department: TaskDepartment =
		input.department ??
		(input.assignedToId !== undefined
			? ((await loadUserDepartment(input.assignedToId)) ??
				DEFAULT_TASK_DEPARTMENT)
			: DEFAULT_TASK_DEPARTMENT);

	if (input.assignedToId !== undefined) {
		await assertValidAssignee(project.id, input.assignedToId, department);
	}

	const task = await db.orm.public.Tasks.create({
		projectId: project.id,
		...(input.assignedToId !== undefined
			? { assignedToId: input.assignedToId }
			: {}),
		title: toVarchar<200>(input.title),
		description:
			input.description !== undefined && input.description.length > 0
				? input.description
				: null,
		status: input.status ?? "TODO",
		priority: input.priority ?? DEFAULT_TASK_PRIORITY,
		department,
		clientVisible: input.clientVisible ?? false,
	});

	return toTaskResponse(task, EMPTY_BLOCKING_STATE);
}

/**
 * A stored task row. `Models.public_Tasks` carries the relation fields too, so
 * the scalar shape is derived from it rather than restated.
 */
type TaskRecord = Pick<
	Models.public_Tasks,
	| "id"
	| "projectId"
	| "assignedToId"
	| "title"
	| "description"
	| "status"
	| "priority"
	| "department"
	| "clientVisible"
	| "version"
	| "createdAt"
	| "updatedAt"
	| "deletedAt"
>;

/** Transaction handle passed to `db.transaction`, reused by the helpers below. */
type TaskTransaction = Parameters<Parameters<typeof db.transaction>[0]>[0];

/**
 * Atomic compare-and-swap for a task row.
 *
 * The expected version travels in the WHERE clause and the increment happens
 * inside the same statement, so PostgreSQL -- not this process -- decides the
 * winner. Two requests that both read version N cannot both match: the loser
 * re-evaluates the predicate against the row it was waiting to lock, updates
 * zero rows, and is rejected on the `affectedCount() === 0` branch. A
 * read-then-write check inside the service would let both through, which is why
 * no application-level lock is used anywhere in this path.
 *
 * The whole row is written rather than a dynamically assembled SET list, so
 * the statement has one fixed shape: fields the caller did not change keep the
 * value from `current`, which was read inside this same transaction. The
 * version guard is what proves `current` is still the row being written.
 *
 * Column names are the physical snake_case ones because this statement is
 * hand-written on purpose: it is the one place in the task module that must
 * bypass the query builder to make the guard part of the SQL.
 */
async function compareAndSwapTask(
	tx: TaskTransaction,
	current: TaskRecord,
	expectedVersion: number,
	changes: {
		readonly title: string;
		readonly description: string | null;
		readonly status: string;
		readonly priority: string;
		readonly department: string;
		readonly assignedToId: string | null;
		readonly clientVisible: boolean;
	},
): Promise<number> {
	const updated = await tx.execute(
		db.raw.sql`UPDATE "public"."tasks"
			SET "title" = ${param(changes.title, { codecId: "pg/text@1" })}::varchar(200),
				"description" = ${param(changes.description, { codecId: "pg/text@1" })}::text,
				"status" = ${changes.status}::"task_status",
				"priority" = ${changes.priority}::"task_priority",
				"department" = ${changes.department}::"department",
				"assigned_to_id" = ${param(changes.assignedToId, { codecId: "pg/uuid@1" })}::uuid,
				"client_visible" = ${changes.clientVisible}::boolean,
				"version" = "tasks"."version" + 1,
				"updated_at" = now()
			WHERE "id" = ${current.id}::uuid
				AND "project_id" = ${current.projectId}::uuid
				AND "version" = ${expectedVersion}::int4
				AND "deleted_at" IS NULL`
			.affectedCount()
			.build(),
	);
	return updated.affectedRows;
}

/**
 * Soft delete guarded by the same compare-and-swap, so a delete and a patch
 * that both start from the same version cannot both win. A stale patch can
 * therefore never resurrect or modify a task that was just deleted.
 */
async function compareAndSwapSoftDelete(
	tx: TaskTransaction,
	current: TaskRecord,
	expectedVersion: number,
	deletedAt: TimestampValue,
): Promise<number> {
	const updated = await tx.execute(
		db.raw.sql`UPDATE "public"."tasks"
			SET "deleted_at" = ${param(deletedAt, { codecId: "pg/timestamp-temporal@1" })}::timestamp,
				"version" = "tasks"."version" + 1,
				"updated_at" = now()
			WHERE "id" = ${current.id}::uuid
				AND "project_id" = ${current.projectId}::uuid
				AND "version" = ${expectedVersion}::int4
				AND "deleted_at" IS NULL`
			.affectedCount()
			.build(),
	);
	return updated.affectedRows;
}

/**
 * Build the 409 for a lost optimistic-lock race.
 *
 * Called only once the compare-and-swap has already matched zero rows, so the
 * row is re-read here to report the version the caller actually collided with
 * plus a ready-to-render snapshot. The snapshot goes through the same
 * client-visibility projection as a normal read, so a conflict can never leak an
 * internal prerequisite to a client.
 */
async function buildVersionConflictError(
	tx: TaskTransaction,
	user: UserContext,
	taskId: string,
	expectedVersion: number,
): Promise<TaskVersionConflictError> {
	const latest = await tx.orm.public.Tasks.where((row) =>
		row.id.eq(taskId),
	).first();
	if (!latest) {
		return new TaskVersionConflictError(
			taskId,
			expectedVersion,
			expectedVersion,
		);
	}
	const latestBlocking = await getBlockingState(
		latest.projectId,
		latest.id,
		user.role === "CLIENT",
	);
	return new TaskVersionConflictError(
		taskId,
		expectedVersion,
		latest.version,
		toTaskResponse(latest, latestBlocking),
	);
}

export async function updateTask(
	user: UserContext,
	projectId: string,
	taskId: string,
	rawInput: unknown,
): Promise<TaskResponse> {
	const input = updateTaskSchema.parse(rawInput);

	const project = await findVisibleProject(projectId);
	if (!project) {
		throw new ProjectNotFoundError();
	}

	const memberIds = await loadMemberIds(project.id);
	const projectContext = toProjectContext(project, memberIds);

	const task = await db.orm.public.Tasks.where((row) => row.id.eq(taskId))
		.where((row) => row.projectId.eq(project.id))
		.where((row) => row.deletedAt.isNull())
		.first();
	if (!task) {
		throw new TaskNotFoundError();
	}

	if (input.title !== undefined && !canEditTask(user, task, projectContext)) {
		throw new TaskAccessDeniedError(
			"You do not have permission to edit this task",
		);
	}
	if (input.description !== undefined && !canEditTaskDescription(user)) {
		throw new TaskAccessDeniedError(
			"You do not have permission to edit the task description",
		);
	}
	if (
		input.status !== undefined &&
		!canChangeTaskStatus(user, task, input.status)
	) {
		throw new TaskAccessDeniedError(
			"You do not have permission to change this task's status",
		);
	}
	if (input.status !== undefined) {
		await validateStatusTransition(project.id, task, input.status);
	}
	if (input.assignedToId !== undefined && !canChangeAssignment(user)) {
		throw new TaskAccessDeniedError(
			"You do not have permission to change task assignment",
		);
	}
	if (input.clientVisible !== undefined && !canChangeClientVisibility(user)) {
		throw new TaskAccessDeniedError(
			"You do not have permission to change client visibility",
		);
	}

	// Priority and department are PM-only metadata: internal users can move a
	// task through its status, but not redefine who owns it or how urgent it is.
	if (
		(input.priority !== undefined || input.department !== undefined) &&
		!canEditTaskMetadata(user)
	) {
		throw new TaskAccessDeniedError(
			"You do not have permission to change task priority or department",
		);
	}

	const nextDepartment: TaskDepartment =
		input.department ?? toTaskDepartment(task.department);

	if (input.assignedToId !== undefined) {
		await assertValidAssignee(project.id, input.assignedToId, nextDepartment);
	}

	// Re-pointing a task at a different team must not leave the current assignee
	// outside the department that now owns the task.
	const currentAssigneeId =
		input.assignedToId !== undefined
			? input.assignedToId
			: (task.assignedToId ?? undefined);
	if (
		currentAssigneeId !== undefined &&
		input.department !== undefined &&
		input.assignedToId === undefined
	) {
		await assertValidAssignee(project.id, currentAssigneeId, nextDepartment);
	}

	const data = {
		...(input.title !== undefined
			? { title: toVarchar<200>(input.title) }
			: {}),
		...(input.description !== undefined
			? {
					description: input.description.length > 0 ? input.description : null,
				}
			: {}),
		...(input.status !== undefined ? { status: input.status } : {}),
		...(input.priority !== undefined ? { priority: input.priority } : {}),
		...(input.department !== undefined ? { department: input.department } : {}),
		...(input.assignedToId !== undefined
			? { assignedToId: input.assignedToId }
			: {}),
		...(input.clientVisible !== undefined
			? { clientVisible: input.clientVisible }
			: {}),
	};

	const updated = await db.transaction(async (tx) => {
		const current = await tx.orm.public.Tasks.where((row) => row.id.eq(task.id))
			.where((row) => row.projectId.eq(project.id))
			.first();
		if (!current) {
			throw new TaskNotFoundError();
		}
		if (current.deletedAt !== null) {
			throw new TaskAlreadyDeletedError();
		}
		if (current.version !== input.version) {
			throw await buildVersionConflictError(tx, user, task.id, input.version);
		}
		const affectedRows = await compareAndSwapTask(tx, current, input.version, {
			title: data.title ?? current.title,
			description:
				data.description === undefined ? current.description : data.description,
			status: data.status ?? current.status,
			priority: data.priority ?? current.priority,
			department: data.department ?? current.department,
			assignedToId:
				data.assignedToId === undefined
					? current.assignedToId
					: data.assignedToId,
			clientVisible: data.clientVisible ?? current.clientVisible,
		});
		if (affectedRows !== 1) {
			// The row no longer matches the version this request was built on.
			// Re-read to report the real current state to the caller.
			throw await buildVersionConflictError(tx, user, task.id, input.version);
		}
		// Re-read inside the same transaction: the row just written is this
		// transaction's own write, so the read cannot observe anyone else's.
		const result = await tx.orm.public.Tasks.where((row) =>
			row.id.eq(task.id),
		).first();
		if (!result) {
			throw new TaskNotFoundError();
		}
		const auditEntries = buildAuditEntries({
			taskId: task.id,
			userId: user.id,
			before: current,
			after: result,
		});
		await createAuditLogs(tx.orm.public.AuditLogs, auditEntries);
		return result;
	});

	const blocking = await getBlockingState(
		project.id,
		updated.id,
		user.role === "CLIENT",
	);
	return toTaskResponse(updated, blocking);
}

export async function softDeleteTask(
	user: UserContext,
	projectId: string,
	taskId: string,
	expectedVersion: number,
): Promise<void> {
	if (!canDeleteTask(user)) {
		throw new TaskAccessDeniedError(
			"You do not have permission to delete tasks",
		);
	}

	const project = await findVisibleProject(projectId);
	if (!project) {
		throw new ProjectNotFoundError();
	}

	const task = await db.orm.public.Tasks.where((row) => row.id.eq(taskId))
		.where((row) => row.projectId.eq(project.id))
		.first();
	if (!task) {
		throw new TaskNotFoundError();
	}
	if (task.deletedAt !== null) {
		throw new TaskAlreadyDeletedError();
	}

	await db.transaction(async (tx) => {
		const current = await tx.orm.public.Tasks.where((row) => row.id.eq(task.id))
			.where((row) => row.projectId.eq(project.id))
			.first();
		if (!current) {
			throw new TaskNotFoundError();
		}
		if (current.deletedAt !== null) {
			throw new TaskAlreadyDeletedError();
		}
		if (current.version !== expectedVersion) {
			throw await buildVersionConflictError(tx, user, task.id, expectedVersion);
		}
		const deletedAt = nowTimestamp();
		// The delete carries the same compare-and-swap guard as an update, so a
		// delete and a patch that both start from the same version cannot both
		// win: whichever statement lands first bumps the version and the other
		// matches zero rows. A stale patch therefore can never resurrect or
		// modify a task that was just deleted.
		const affectedRows = await compareAndSwapSoftDelete(
			tx,
			current,
			expectedVersion,
			deletedAt,
		);
		if (affectedRows !== 1) {
			throw await buildVersionConflictError(tx, user, task.id, expectedVersion);
		}
		const auditEntries = buildAuditEntries({
			taskId: task.id,
			userId: user.id,
			before: current,
			after: { ...current, deletedAt },
		});
		await createAuditLogs(tx.orm.public.AuditLogs, auditEntries);
	});
}

function asArray<T>(value: T | T[] | undefined): T[] | undefined {
	if (value === undefined) {
		return undefined;
	}
	return Array.isArray(value) ? value : [value];
}

/**
 * Cross-project task list for the flat `/tasks` endpoint.
 *
 * Every predicate is pushed into the database query, so an internal user can
 * never page past their own projects and no row is loaded only to be discarded.
 */
export async function listAllTasks(
	user: UserContext,
	query: TaskOfficialListQueryInput = DEFAULT_TASK_LIST_QUERY,
): Promise<TaskListResponse> {
	assertInternalTaskApiAccess(user);

	const { page, rows, filters, searchFilters, rangedFilters, orderRule } =
		query;
	const accessScopeProjectIds = await resolveTaskAccessScope(user);

	if (accessScopeProjectIds !== null && accessScopeProjectIds.length === 0) {
		return { tasks: [], pagination: toPagination(page, rows, 0) };
	}

	let collection = db.orm.public.Tasks.where((task) => task.deletedAt.isNull());

	if (accessScopeProjectIds !== null) {
		collection = collection.where((task) =>
			task.projectId.in(accessScopeProjectIds),
		);
	}

	const ids = asArray(filters.id as string | string[] | undefined);
	if (ids !== undefined) {
		collection = collection.where((task) => task.id.in(ids));
	}

	const projectIds = asArray(
		filters.projectId as string | string[] | undefined,
	);
	if (projectIds !== undefined) {
		collection = collection.where((task) => task.projectId.in(projectIds));
	}

	const assignedToIds = asArray(
		filters.assignedToId as string | string[] | undefined,
	);
	if (assignedToIds !== undefined) {
		collection = collection.where((task) =>
			task.assignedToId.in(assignedToIds),
		);
	}

	const statuses = asArray(filters.status as string | string[] | undefined);
	if (statuses !== undefined) {
		collection = collection.where((task) =>
			task.status.in(statuses as TaskResponse["status"][]),
		);
	}

	const priorities = asArray(filters.priority as string | string[] | undefined);
	if (priorities !== undefined) {
		collection = collection.where((task) =>
			task.priority.in(priorities as TaskResponse["priority"][]),
		);
	}

	const departments = asArray(
		filters.department as string | string[] | undefined,
	);
	if (departments !== undefined) {
		collection = collection.where((task) =>
			task.department.in(departments as TaskResponse["department"][]),
		);
	}

	const clientVisible = filters.clientVisible as boolean | undefined;
	if (clientVisible !== undefined) {
		collection = collection.where((task) =>
			task.clientVisible.eq(clientVisible),
		);
	}

	if (searchFilters.title !== undefined) {
		collection = collection.where((task) =>
			task.title.ilike(`%${escapeLikePattern(searchFilters.title as string)}%`),
		);
	}

	if (searchFilters.description !== undefined) {
		collection = collection.where((task) =>
			task.description.ilike(
				`%${escapeLikePattern(searchFilters.description as string)}%`,
			),
		);
	}

	for (const range of rangedFilters) {
		if (range.key === "createdAt" || range.key === "updatedAt") {
			const field = range.key;
			const start = range.start;
			const end = range.end;
			if (start !== undefined) {
				collection = collection.where((task) =>
					task[field].gte(toTimestamp(start)),
				);
			}
			if (end !== undefined) {
				collection = collection.where((task) =>
					task[field].lte(toTimestamp(end)),
				);
			}
		}
	}

	const countResult = await collection.aggregate((aggregate) => ({
		total: aggregate.count(),
	}));

	const orderKey = query.orderKey ?? "createdAt";
	const tasks = await collection
		.orderBy((task) =>
			orderRule === "asc" ? task[orderKey].asc() : task[orderKey].desc(),
		)
		.limit(rows)
		.offset((page - 1) * rows)
		.all();

	// Dependency graphs are per project, so a cross-project page is resolved one
	// project at a time and then merged back into a single id-keyed map.
	const blockingStates = new Map<string, TaskBlockingState>();
	const taskIdsByProject = new Map<string, string[]>();
	for (const task of tasks) {
		const bucket = taskIdsByProject.get(task.projectId);
		if (bucket === undefined) {
			taskIdsByProject.set(task.projectId, [task.id]);
		} else {
			bucket.push(task.id);
		}
	}
	for (const [projectId, taskIds] of taskIdsByProject) {
		const states = await computeTaskBlockingStates(projectId, taskIds, {
			visibleOnly: false,
		});
		for (const [taskId, state] of states) {
			blockingStates.set(taskId, state);
		}
	}

	return {
		tasks: tasks.map((task) =>
			toTaskResponse(task, blockingStates.get(task.id) ?? EMPTY_BLOCKING_STATE),
		),
		pagination: toPagination(page, rows, countResult.total),
	};
}

async function loadAssigneeRow(
	assignedToId: string | null,
): Promise<TaskAssigneeRow | null> {
	if (assignedToId === null) {
		return null;
	}
	const user = await db.orm.public.Users.first({ id: assignedToId });
	if (!user) {
		return null;
	}
	return {
		id: user.id,
		name: user.name,
		email: user.email,
		department: user.department,
	};
}

/**
 * Cross-project task detail. The owning project is resolved first so the same
 * project membership rule that guards the nested route guards this one.
 */
export async function getTaskById(
	user: UserContext,
	taskId: string,
): Promise<TaskDetailResponse> {
	assertInternalTaskApiAccess(user);

	const task = await db.orm.public.Tasks.where((row) => row.id.eq(taskId))
		.where((row) => row.deletedAt.isNull())
		.first();
	if (!task) {
		throw new TaskNotFoundError();
	}

	const project = await findVisibleProject(task.projectId);
	if (!project) {
		throw new TaskNotFoundError();
	}

	const memberIds = await loadMemberIds(project.id);
	const projectContext = toProjectContext(project, memberIds);

	if (!canViewTask(user, task, projectContext)) {
		throw new TaskAccessDeniedError();
	}

	const [blocking, assignee] = await Promise.all([
		getBlockingState(project.id, task.id, false),
		loadAssigneeRow(task.assignedToId ?? null),
	]);

	return toTaskDetailResponse(task, blocking, {
		project: {
			id: project.id,
			name: project.name,
			status: project.status,
		},
		assignee,
	});
}

/**
 * Flat create. Reuses the nested creation path so validation, department
 * inference, and audit behaviour stay identical between the two surfaces.
 */
export async function createTaskForProject(
	user: UserContext,
	rawInput: unknown,
): Promise<TaskResponse> {
	const input = createFlatTaskSchema.parse(rawInput);
	const { projectId, ...taskInput } = input;
	return createTask(user, projectId, taskInput);
}

export async function updateTaskById(
	user: UserContext,
	taskId: string,
	rawInput: unknown,
): Promise<TaskDetailResponse> {
	const task = await db.orm.public.Tasks.where((row) => row.id.eq(taskId))
		.where((row) => row.deletedAt.isNull())
		.first();
	if (!task) {
		throw new TaskNotFoundError();
	}

	await updateTask(user, task.projectId, taskId, rawInput);
	return getTaskById(user, taskId);
}

export async function softDeleteTaskById(
	user: UserContext,
	taskId: string,
	expectedVersion: number,
): Promise<void> {
	const task = await db.orm.public.Tasks.where((row) =>
		row.id.eq(taskId),
	).first();
	if (!task || task.deletedAt !== null) {
		throw new TaskNotFoundError();
	}
	await softDeleteTask(user, task.projectId, taskId, expectedVersion);
}
