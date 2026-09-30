import type { Models } from "../../prisma/contract";
import { db } from "../../prisma/db";
import type {
	ProjectAuthorizationContext,
	TaskStatus,
	UserContext,
} from "../authorization/authorization.types";
import { computeTaskBlockingStates } from "../dependencies/dependency.service";
import { ProjectNotFoundError } from "../projects/project.errors";
import { TaskNotFoundError } from "../tasks/task.errors";
import type { Pagination } from "../tasks/task.types";
import { ClientAccessDeniedError } from "./client.errors";
import {
	canAccessClientApi,
	canAccessClientProject,
	canViewClientDashboard,
} from "./client.policy";
import type {
	ClientDashboardResponse,
	ClientTaskDto,
	ClientTaskListQuery,
	ClientTaskListResponse,
	ClientTaskRecord,
} from "./client.types";

type ProjectRow = Omit<
	Models.public_Projects,
	"members" | "tasks" | "invitations"
>;

function escapeLikePattern(value: string): string {
	return value.replace(/[\\%_]/g, "\\$&");
}

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

export function toClientTask(task: ClientTaskRecord): ClientTaskDto {
	return {
		id: task.id,
		title: task.title,
		description: task.description,
		status: task.status,
		clientVisible: task.clientVisible,
	};
}

type TaskMetrics = {
	total: number;
	completed: number;
	inProgress: number;
	todo: number;
	blocked: number;
};

async function loadClientVisibleTaskMetrics(
	projectId: string,
): Promise<TaskMetrics> {
	async function countByStatus(status?: TaskStatus): Promise<number> {
		let collection = db.orm.public.Tasks.where((task) =>
			task.projectId.eq(projectId),
		)
			.where((task) => task.deletedAt.isNull())
			.where((task) => task.clientVisible.eq(true));
		if (status !== undefined) {
			collection = collection.where((task) => task.status.eq(status));
		}
		const result = await collection.aggregate((aggregate) => ({
			total: aggregate.count(),
		}));
		return result.total;
	}

	const [total, completed, inProgress, todo, blocked] = await Promise.all([
		countByStatus(),
		countByStatus("DONE"),
		countByStatus("IN_PROGRESS"),
		countByStatus("TODO"),
		countBlockedByDependencies(),
	]);

	return { total, completed, inProgress, todo, blocked };

	/**
	 * The client sees a blocked *count*, never the prerequisites behind it, so
	 * the number is derived from the same graph the server uses internally with
	 * internal-only prerequisites filtered out. Counting the persisted
	 * `BLOCKED` status instead would report zero for work that is genuinely
	 * blocked by an internal prerequisite.
	 */
	async function countBlockedByDependencies(): Promise<number> {
		const clientVisibleTasks = await db.orm.public.Tasks.where((task) =>
			task.projectId.eq(projectId),
		)
			.where((task) => task.deletedAt.isNull())
			.where((task) => task.clientVisible.eq(true))
			.select("id")
			.all();
		if (clientVisibleTasks.length === 0) {
			return 0;
		}
		const states = await computeTaskBlockingStates(
			projectId,
			clientVisibleTasks.map((task) => task.id),
			{ visibleOnly: true },
		);
		return [...states.values()].filter((state) => state.blocked).length;
	}
}

function computePercentage(completed: number, total: number): number {
	if (total === 0) {
		return 0;
	}
	return Math.round((completed / total) * 100);
}

async function requireClientProject(
	user: UserContext,
	projectId: string,
): Promise<ProjectRow> {
	const project = await findVisibleProject(projectId);
	if (!project) {
		throw new ProjectNotFoundError();
	}

	const memberIds = await loadMemberIds(project.id);
	if (!canAccessClientProject(user, toProjectContext(project, memberIds))) {
		throw new ProjectNotFoundError();
	}

	return project;
}

function toPagination(page: number, limit: number, total: number): Pagination {
	return {
		page,
		limit,
		total,
		totalPages: Math.ceil(total / limit),
	};
}

export async function getClientDashboard(
	user: UserContext,
): Promise<ClientDashboardResponse> {
	if (!canViewClientDashboard(user)) {
		throw new ClientAccessDeniedError();
	}

	const memberships = await db.orm.public.ProjectMembers.where((member) =>
		member.userId.eq(user.id),
	)
		.select("projectId")
		.all();
	const memberProjectIds = memberships.map(
		(membership) => membership.projectId,
	);

	const projects =
		memberProjectIds.length === 0
			? []
			: await db.orm.public.Projects.where((project) =>
					project.deletedAt.isNull(),
				)
					.where((project) => project.id.in([...memberProjectIds]))
					.orderBy((project) => project.createdAt.desc())
					.all();

	const dashboardProjects = await Promise.all(
		projects.map(async (project) => {
			const metrics = await loadClientVisibleTaskMetrics(project.id);
			return {
				id: project.id,
				name: project.name,
				progress: {
					percentage: computePercentage(metrics.completed, metrics.total),
				},
				tasks: metrics,
			};
		}),
	);

	return { projects: dashboardProjects };
}

export async function listClientTasks(
	user: UserContext,
	projectId: string,
	query: ClientTaskListQuery,
): Promise<ClientTaskListResponse> {
	if (!canAccessClientApi(user)) {
		throw new ClientAccessDeniedError();
	}

	const project = await requireClientProject(user, projectId);

	const page = query.page;
	const limit = query.limit;
	const status = query.status;
	const search =
		query.search === undefined || query.search.length === 0
			? undefined
			: query.search;

	let collection = db.orm.public.Tasks.where((task) =>
		task.projectId.eq(project.id),
	)
		.where((task) => task.deletedAt.isNull())
		.where((task) => task.clientVisible.eq(true));

	if (status !== undefined) {
		collection = collection.where((task) => task.status.eq(status));
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

	return {
		tasks: tasks.map(toClientTask),
		pagination: toPagination(page, limit, countResult.total),
	};
}

export async function getClientTask(
	user: UserContext,
	projectId: string,
	taskId: string,
): Promise<ClientTaskDto> {
	if (!canAccessClientApi(user)) {
		throw new ClientAccessDeniedError();
	}

	const project = await requireClientProject(user, projectId);

	const task = await db.orm.public.Tasks.where((row) => row.id.eq(taskId))
		.where((row) => row.projectId.eq(project.id))
		.where((row) => row.deletedAt.isNull())
		.where((row) => row.clientVisible.eq(true))
		.first();
	if (!task) {
		throw new TaskNotFoundError();
	}

	return toClientTask(task);
}
