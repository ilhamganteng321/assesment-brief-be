import { HttpError } from "../../lib/http-error";
import type { Models } from "../../prisma/contract";
import { db } from "../../prisma/db";
import { nowTimestamp, toTimestamp, toVarchar } from "../../prisma/scalars";
import type {
	ProjectAuthorizationContext,
	UserContext,
} from "../authorization/authorization.types";
import { toProjectResponse } from "./project.dto";
import {
	ProjectAccessDeniedError,
	ProjectAlreadyDeletedError,
	ProjectMemberAlreadyExistsError,
	ProjectMemberNotFoundError,
	ProjectNotFoundError,
	ProjectUserNotFoundError,
} from "./project.errors";
import {
	canCreateProject,
	canDeleteProject,
	canManageProjectMembers,
	canUpdateProject,
	canUseInternalProjectApi,
	canViewProject,
} from "./project.policy";
import {
	createProjectSchema,
	DEFAULT_PROJECT_LIST_QUERY,
	type ProjectListQuery,
	updateProjectSchema,
} from "./project.schema";
import type {
	Pagination,
	ProjectListResponse,
	ProjectMemberRecord,
	ProjectMemberResponse,
	ProjectMemberWithUser,
	ProjectRecord,
	ProjectResponse,
} from "./project.types";

type UserRow = Omit<
	Models.public_Users,
	| "assignedTasks"
	| "attachments"
	| "auditLogs"
	| "createdTaskDependencies"
	| "projectMembers"
>;

function escapeLikePattern(value: string): string {
	return value.replace(/[\\%_]/g, "\\$&");
}

function toPagination(page: number, limit: number, total: number): Pagination {
	return {
		page,
		limit,
		total,
		totalPages: Math.ceil(total / limit),
	};
}

async function findVisibleProject(
	projectId: string,
): Promise<ProjectRecord | null> {
	return db.orm.public.Projects.where((project) => project.id.eq(projectId))
		.where((project) => project.deletedAt.isNull())
		.first();
}

async function loadMemberships(
	projectId: string,
): Promise<ProjectMemberRecord[]> {
	return db.orm.public.ProjectMembers.where((member) =>
		member.projectId.eq(projectId),
	).all();
}

async function loadUsersByIds(ids: readonly string[]): Promise<UserRow[]> {
	if (ids.length === 0) {
		return [];
	}
	return db.orm.public.Users.where((user) => user.id.in([...ids])).all();
}

function requireUser(
	usersById: Map<string, UserRow>,
	userId: string,
): ProjectMemberWithUser["user"] {
	const user = usersById.get(userId);
	if (!user) {
		throw new HttpError(
			500,
			"INTERNAL_SERVER_ERROR",
			"A project member references a missing user",
		);
	}
	return {
		id: user.id,
		name: user.name,
		email: user.email,
		department: user.department,
	};
}

function toContext(
	project: Pick<ProjectRecord, "id" | "status">,
	memberships: readonly { readonly userId: string }[],
): ProjectAuthorizationContext {
	return {
		id: project.id,
		status: project.status,
		memberships: memberships.map((membership) => ({
			userId: membership.userId,
		})),
	};
}

function assertInternalApiAccess(user: UserContext): void {
	if (!canUseInternalProjectApi(user)) {
		throw new ProjectAccessDeniedError(
			"This project data is only available to internal team members",
		);
	}
}

function assertCanView(
	user: UserContext,
	project: ProjectRecord,
	memberships: readonly ProjectMemberRecord[],
): void {
	if (!canViewProject(user, toContext(project, memberships))) {
		throw new ProjectAccessDeniedError();
	}
}

/**
 * Resolves the caller's access scope as a set of project ids.
 *
 * PMs are unscoped; every other role may only ever see projects they are a
 * member of. The returned ids are applied to the database query itself, so user
 * supplied filters can never widen access.
 */
async function resolveAccessScopeProjectIds(
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

export async function listProjects(
	user: UserContext,
	query: ProjectListQuery = DEFAULT_PROJECT_LIST_QUERY,
): Promise<ProjectListResponse> {
	assertInternalApiAccess(user);
	const { page, rows, filters, searchFilters, rangedFilters } = query;
	const orderRule = query.orderRule;
	const accessScopeProjectIds = await resolveAccessScopeProjectIds(user);

	if (accessScopeProjectIds !== null && accessScopeProjectIds.length === 0) {
		return { projects: [], pagination: toPagination(page, rows, 0) };
	}

	let collection = db.orm.public.Projects.where((project) =>
		project.deletedAt.isNull(),
	);

	if (accessScopeProjectIds !== null) {
		collection = collection.where((project) =>
			project.id.in(accessScopeProjectIds),
		);
	}

	if (filters.status !== undefined) {
		const statuses = Array.isArray(filters.status)
			? filters.status
			: [filters.status];
		collection = collection.where((project) =>
			project.status.in(statuses as ProjectResponse["status"][]),
		);
	}

	if (filters.id !== undefined) {
		const ids = Array.isArray(filters.id) ? filters.id : [filters.id];
		collection = collection.where((project) => project.id.in(ids));
	}

	if (filters.clientName !== undefined) {
		collection = collection.where((project) =>
			project.clientName.eq(toVarchar<150>(filters.clientName as string)),
		);
	}

	if (searchFilters.name !== undefined) {
		collection = collection.where((project) =>
			project.name.ilike(
				`%${escapeLikePattern(searchFilters.name as string)}%`,
			),
		);
	}

	if (searchFilters.clientName !== undefined) {
		collection = collection.where((project) =>
			project.clientName.ilike(
				`%${escapeLikePattern(searchFilters.clientName as string)}%`,
			),
		);
	}

	for (const range of rangedFilters) {
		if (range.key === "createdAt" || range.key === "updatedAt") {
			const field = range.key;
			if (range.start !== undefined) {
				collection = collection.where((project) =>
					project[field].gte(toTimestamp(range.start as string)),
				);
			}
			if (range.end !== undefined) {
				collection = collection.where((project) =>
					project[field].lte(toTimestamp(range.end as string)),
				);
			}
		}
	}

	const countResult = await collection.aggregate((aggregate) => ({
		total: aggregate.count(),
	}));

	const orderKey = query.orderKey ?? "createdAt";
	const projects = await collection
		.orderBy((project) =>
			orderRule === "asc" ? project[orderKey].asc() : project[orderKey].desc(),
		)
		.limit(rows)
		.offset((page - 1) * rows)
		.all();

	return {
		projects: projects.map(toProjectResponse),
		pagination: toPagination(page, rows, countResult.total),
	};
}

export async function getProjectById(
	user: UserContext,
	projectId: string,
): Promise<ProjectResponse> {
	assertInternalApiAccess(user);
	const project = await findVisibleProject(projectId);
	if (!project) {
		throw new ProjectNotFoundError();
	}

	const memberships = await loadMemberships(project.id);
	assertCanView(user, project, memberships);

	return toProjectResponse(project);
}

export async function createProject(
	user: UserContext,
	rawInput: unknown,
): Promise<ProjectResponse> {
	assertInternalApiAccess(user);
	if (!canCreateProject(user)) {
		throw new ProjectAccessDeniedError(
			"You do not have permission to create projects",
		);
	}

	const input = createProjectSchema.parse(rawInput);

	const project = await db.orm.public.Projects.create({
		name: toVarchar<150>(input.name),
		description:
			input.description !== undefined && input.description.length > 0
				? input.description
				: null,
		clientName:
			input.clientName !== undefined && input.clientName.length > 0
				? toVarchar<150>(input.clientName)
				: null,
		status: input.status ?? "ACTIVE",
	});

	return toProjectResponse(project);
}

export async function updateProject(
	user: UserContext,
	projectId: string,
	rawInput: unknown,
): Promise<ProjectResponse> {
	assertInternalApiAccess(user);
	if (!canUpdateProject(user)) {
		throw new ProjectAccessDeniedError(
			"You do not have permission to update projects",
		);
	}

	const input = updateProjectSchema.parse(rawInput);

	const project = await findVisibleProject(projectId);
	if (!project) {
		throw new ProjectNotFoundError();
	}

	const data = {
		...(input.name !== undefined ? { name: toVarchar<150>(input.name) } : {}),
		...(input.description !== undefined
			? {
					description: input.description.length > 0 ? input.description : null,
				}
			: {}),
		...(input.clientName !== undefined
			? {
					clientName:
						input.clientName.length > 0
							? toVarchar<150>(input.clientName)
							: null,
				}
			: {}),
		...(input.status !== undefined ? { status: input.status } : {}),
	};

	const updated = await db.orm.public.Projects.where((p) =>
		p.id.eq(project.id),
	).update(data);
	if (updated === null) {
		throw new ProjectNotFoundError();
	}

	return toProjectResponse(updated);
}

export async function deleteProject(
	user: UserContext,
	projectId: string,
): Promise<void> {
	assertInternalApiAccess(user);
	if (!canDeleteProject(user)) {
		throw new ProjectAccessDeniedError(
			"You do not have permission to delete projects",
		);
	}

	const project = await db.orm.public.Projects.first({ id: projectId });
	if (!project) {
		throw new ProjectNotFoundError();
	}
	if (project.deletedAt !== null) {
		throw new ProjectAlreadyDeletedError();
	}

	await db.orm.public.Projects.where((p) => p.id.eq(project.id)).update({
		deletedAt: nowTimestamp(),
	});
}

export async function getProjectMembers(
	user: UserContext,
	projectId: string,
): Promise<ProjectMemberResponse[]> {
	assertInternalApiAccess(user);
	const project = await findVisibleProject(projectId);
	if (!project) {
		throw new ProjectNotFoundError();
	}

	const memberships = await loadMemberships(project.id);
	assertCanView(user, project, memberships);

	const users = await loadUsersByIds(
		memberships.map((member) => member.userId),
	);
	const usersById = new Map(users.map((user) => [user.id, user]));

	return memberships.map((member) => ({
		id: member.id,
		projectId: member.projectId,
		userId: member.userId,
		createdAt: String(member.createdAt),
		user: requireUser(usersById, member.userId),
	}));
}

export async function addProjectMember(
	user: UserContext,
	projectId: string,
	userId: string,
): Promise<ProjectMemberRecord> {
	assertInternalApiAccess(user);
	if (!canManageProjectMembers(user)) {
		throw new ProjectAccessDeniedError(
			"You do not have permission to manage project members",
		);
	}

	const project = await findVisibleProject(projectId);
	if (!project) {
		throw new ProjectNotFoundError();
	}

	const target = await db.orm.public.Users.first({ id: userId });
	if (!target) {
		throw new ProjectUserNotFoundError();
	}

	const existing = await db.orm.public.ProjectMembers.where((member) =>
		member.projectId.eq(project.id),
	)
		.where((member) => member.userId.eq(userId))
		.first();
	if (existing) {
		throw new ProjectMemberAlreadyExistsError();
	}

	return db.orm.public.ProjectMembers.create({
		projectId: project.id,
		userId,
	});
}

export async function removeProjectMember(
	user: UserContext,
	projectId: string,
	userId: string,
): Promise<void> {
	assertInternalApiAccess(user);
	if (!canManageProjectMembers(user)) {
		throw new ProjectAccessDeniedError(
			"You do not have permission to manage project members",
		);
	}

	const project = await findVisibleProject(projectId);
	if (!project) {
		throw new ProjectNotFoundError();
	}

	const member = await db.orm.public.ProjectMembers.where((row) =>
		row.projectId.eq(project.id),
	)
		.where((row) => row.userId.eq(userId))
		.first();
	if (!member) {
		throw new ProjectMemberNotFoundError();
	}

	await db.orm.public.ProjectMembers.where((row) =>
		row.id.eq(member.id),
	).delete();
}
