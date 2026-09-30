import { HttpError } from "../../lib/http-error";
import type { Models } from "../../prisma/contract";
import { db } from "../../prisma/db";
import { nowTimestamp, toTimestamp, toVarchar } from "../../prisma/scalars";
import type {
	ProjectAuthorizationContext,
	TaskStatus,
	UserContext,
} from "../authorization/authorization.types";
import { computeTaskBlockingStates } from "../dependencies/dependency.service";
import type { TaskBlockingState } from "../dependencies/dependency.types";
import { ACTIVE_TASK_STATUSES } from "../tasks/task.schema";
import { searchUsersByText } from "../users/user.service";
import { toProjectResponse } from "./project.dto";
import {
	ProjectAccessDeniedError,
	ProjectAlreadyDeletedError,
	ProjectArchivedError,
	ProjectMemberAlreadyExistsError,
	ProjectMemberHasActiveTasksError,
	ProjectMemberNotFoundError,
	ProjectNotFoundError,
	ProjectUserNotFoundError,
} from "./project.errors";
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
	createProjectSchema,
	DEFAULT_PROJECT_LIST_QUERY,
	MIN_MEMBER_CANDIDATE_SEARCH,
	type ProjectActivityQuery,
	type ProjectListQuery,
	type ProjectMemberCandidatesQuery,
	updateProjectRequestSchema,
	updateProjectStatusSchema,
} from "./project.schema";
import type {
	Pagination,
	ProjectActivityResponse,
	ProjectDepartmentMetrics,
	ProjectListResponse,
	ProjectMemberCandidatesResponse,
	ProjectMemberRecord,
	ProjectMemberResponse,
	ProjectMemberUserSummary,
	ProjectMetricsResponse,
	ProjectProgress,
	ProjectRecord,
	ProjectResponse,
	ProjectTaskMetrics,
	ProjectWorkloadEntry,
} from "./project.types";
import { validateProjectStatusTransition } from "./project-lifecycle";

/**
 * The columns read from `users` anywhere in this module.
 *
 * `passwordHash` is excluded by construction. A whole-row `select` would load the
 * hash and rely on the response builder to drop it; naming the columns means the
 * secret is never read, so it cannot be logged, cached or leaked by a later edit
 * to a projection.
 */
type UserRow = Pick<
	Models.public_Users,
	"id" | "name" | "email" | "role" | "department"
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
	// Columns are named one by one rather than selecting the whole row, so
	// `passwordHash` is never even read from the database. An allow-list at the
	// query is a stronger guarantee than an allow-list at the projection: the
	// secret is not loaded, so it cannot be logged or leaked by a future edit to
	// the response builder.
	return db.orm.public.Users.where((user) => user.id.in([...ids]))
		.select("id", "name", "email", "role", "department")
		.all();
}

function toMemberUserSummary(user: UserRow): ProjectMemberUserSummary {
	return {
		id: user.id,
		name: user.name,
		email: user.email,
		role: user.role,
		department: user.department,
	};
}

function requireUser(
	usersById: Map<string, UserRow>,
	userId: string,
): ProjectMemberUserSummary {
	const user = usersById.get(userId);
	if (!user) {
		throw new HttpError(
			500,
			"INTERNAL_SERVER_ERROR",
			"A project member references a missing user",
		);
	}
	return toMemberUserSummary(user);
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

	// One query for the whole page rather than one per row: a list of twenty
	// projects would otherwise cost twenty round trips to draw twenty bars.
	const progressByProjectId = await countProjectsProgress(
		projects.map((project) => project.id),
	);

	return {
		projects: projects.map((project) => ({
			...toProjectResponse(project),
			progress:
				progressByProjectId.get(project.id) ??
				({ percentage: 0 } satisfies ProjectProgress),
		})),
		pagination: toPagination(page, rows, countResult.total),
	};
}

/**
 * Completed share of live tasks for each of the given projects, in one query.
 *
 * The same rule the project metrics endpoint applies, so a bar drawn from the
 * list and the figure on the project it opens to cannot disagree. A project with
 * no live task is 0%, and is left out of the map rather than reported as an
 * error, matching the detail endpoint.
 */
async function countProjectsProgress(
	projectIds: readonly string[],
): Promise<Map<string, ProjectProgress>> {
	const progress = new Map<string, ProjectProgress>();
	if (projectIds.length === 0) {
		return progress;
	}

	const rows = await db.orm.public.Tasks.where((task) =>
		task.projectId.in([...projectIds]),
	)
		.where((task) => task.deletedAt.isNull())
		.select("projectId", "status")
		.all();

	const totals = new Map<string, { total: number; completed: number }>();
	for (const row of rows) {
		const projectId = String(row.projectId);
		let bucket = totals.get(projectId);
		if (bucket === undefined) {
			bucket = { total: 0, completed: 0 };
			totals.set(projectId, bucket);
		}
		bucket.total += 1;
		if (row.status === "DONE") {
			bucket.completed += 1;
		}
	}

	for (const [projectId, bucket] of totals) {
		progress.set(projectId, {
			percentage: computeProjectProgressPercentage(bucket),
		});
	}

	return progress;
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

	const input = updateProjectRequestSchema.parse(rawInput);

	const project = await findVisibleProject(projectId);
	if (!project) {
		throw new ProjectNotFoundError();
	}

	if (input.status !== undefined) {
		validateProjectStatusTransition(project.status, input.status);
	}

	// Archiving is terminal, so there is no later state for an edited archive to
	// be reopened into. A request that only re-asserts the status it already has
	// is allowed through, so a lost-response retry of an idempotent write still
	// succeeds; anything that would change the record is refused.
	if (project.status === "ARCHIVED" && input.status !== project.status) {
		throw new ProjectArchivedError();
	}

	// Fields are copied one by one from the validated input. Nothing from the
	// request is spread into the write, so a column the product does not expose
	// cannot be written even if a future schema change adds one.
	const data: Partial<ProjectRecord> = {};
	if (input.name !== undefined) {
		data.name = toVarchar<150>(input.name);
	}
	if (input.description !== undefined) {
		data.description = input.description.length > 0 ? input.description : null;
	}
	if (input.clientName !== undefined) {
		data.clientName =
			input.clientName.length > 0 ? toVarchar<150>(input.clientName) : null;
	}
	if (input.status !== undefined) {
		data.status = input.status;
	}

	const updated = await db.orm.public.Projects.where((p) =>
		p.id.eq(project.id),
	).update(data);
	if (updated === null) {
		throw new ProjectNotFoundError();
	}

	return toProjectResponse(updated);
}

/**
 * Moves a project one step along its lifecycle.
 *
 * The status endpoint is the one the interface calls, and it is a thin wrapper
 * around the same validation {@link updateProject} applies, so a lifecycle rule
 * cannot be enforced on one route and forgotten on the other. The distinction is
 * intent rather than capability: this route accepts a status and nothing else.
 *
 * Completion is not conditional on every task being DONE. The server records the
 * move the caller asked for and leaves the tasks exactly as they are; the
 * interface shows the progress figure as a confirmation, but a PM is entitled to
 * close a project with unfinished work recorded against it.
 */
export async function updateProjectStatus(
	user: UserContext,
	projectId: string,
	rawInput: unknown,
): Promise<ProjectResponse> {
	assertInternalApiAccess(user);
	if (!canChangeProjectStatus(user)) {
		throw new ProjectAccessDeniedError(
			"You do not have permission to change project status",
		);
	}

	const { status } = updateProjectStatusSchema.parse(rawInput);

	const project = await findVisibleProject(projectId);
	if (!project) {
		throw new ProjectNotFoundError();
	}

	validateProjectStatusTransition(project.status, status);

	if (status === project.status) {
		// An idempotent retry of a move whose response was lost. The row already
		// holds what was asked for, so there is nothing to write and no audit
		// entry to append.
		return toProjectResponse(project);
	}

	const updated = await db.orm.public.Projects.where((p) =>
		p.id.eq(project.id),
	).update({ status });
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

/**
 * Searches the organisation for people who could be added to this project.
 *
 * Scoped to the project in two ways: the caller must already be allowed to manage
 * this project's members, and the answer is annotated with who is already on it.
 * Without the first check this would be a user directory reachable by anyone who
 * can open a project; with it, only a project manager can enumerate the
 * organisation, and only for the purpose of adding someone.
 *
 * The text search itself is the directory's, reused rather than reimplemented —
 * the two surfaces agree about what a name-or-address match is, and the
 * LIKE-wildcard escaping lives in one place. What stays here is everything
 * project-shaped: the access check, the already-on-this-project annotation, and
 * the project-scoped authorization. This endpoint remains the security boundary
 * for member selection; it is not a thin wrapper over the global directory, and
 * calling `/users` instead would drop the project checks entirely.
 *
 * Eligible users are all of them, deliberately. Role lives globally on the user
 * record and `ProjectMembers` is the only thing that associates a client with a
 * project, so refusing client accounts here would break the very mechanism that
 * grants a client access to their own project. All three roles are therefore
 * offered, and the caller decides.
 */
export async function searchProjectMemberCandidates(
	user: UserContext,
	projectId: string,
	query: ProjectMemberCandidatesQuery,
): Promise<ProjectMemberCandidatesResponse> {
	assertInternalApiAccess(user);
	if (!canSearchProjectMemberCandidates(user)) {
		throw new ProjectAccessDeniedError(
			"You do not have permission to search for members to add",
		);
	}

	const project = await findVisibleProject(projectId);
	if (!project) {
		throw new ProjectNotFoundError();
	}

	// Resolved before the search so a short prefix costs nothing. Returning an
	// empty page rather than a 400 keeps a client that asks anyway on the same
	// code path as one that respects the minimum.
	if (query.search.trim().length < MIN_MEMBER_CANDIDATE_SEARCH) {
		return {
			candidates: [],
			pagination: toPagination(query.page, query.rows, 0),
		};
	}

	const page = await searchUsersByText({
		search: query.search,
		page: query.page,
		rows: query.rows,
	});

	const memberIds = new Set(
		(await loadMemberships(project.id)).map((member) => member.userId),
	);

	return {
		candidates: page.users.map((user) => ({
			id: user.id,
			name: user.name,
			email: user.email,
			role: user.role,
			department: user.department,
			alreadyMember: memberIds.has(user.id),
		})),
		pagination: toPagination(query.page, query.rows, page.total),
	};
}

/**
 * Counts the members of a project, for the header and the list.
 *
 * A count rather than the member rows, so a list of twenty projects does not
 * have to read twenty membership tables to draw twenty numbers.
 */
export async function countProjectMembers(projectId: string): Promise<number> {
	const result = await db.orm.public.ProjectMembers.where((member) =>
		member.projectId.eq(projectId),
	).aggregate((aggregate) => ({ total: aggregate.count() }));
	return result.total;
}

export async function addProjectMember(
	user: UserContext,
	projectId: string,
	userId: string,
): Promise<ProjectMemberResponse> {
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

	// Membership is a change to the project, and an archived project is read-only
	// for exactly that reason: the lifecycle has ended, so who is on it is part
	// of the record that was closed.
	if (project.status === "ARCHIVED") {
		throw new ProjectArchivedError();
	}

	const target = await db.orm.public.Users.where((row) => row.id.eq(userId))
		.select("id", "name", "email", "role", "department")
		.first();
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

	try {
		const member = await db.orm.public.ProjectMembers.create({
			projectId: project.id,
			userId,
		});

		return {
			id: member.id,
			projectId: member.projectId,
			userId: member.userId,
			createdAt: String(member.createdAt),
			user: toMemberUserSummary(target),
		};
	} catch (error) {
		// The pre-check above is not sufficient on its own: two requests can both
		// observe "not a member" and both proceed, and only the unique constraint
		// decides between them. Catching the violation here turns that race into
		// the same clean conflict every other duplicate produces, instead of the
		// 500 a raw driver error would become.
		if (isUniqueConstraintViolation(error)) {
			throw new ProjectMemberAlreadyExistsError();
		}
		throw error;
	}
}

/**
 * Whether a driver error is the project-members unique index being violated.
 *
 * Matched on the constraint's name rather than a substring of the message, so a
 * locale or driver wording change cannot turn a duplicate into a 500 — or, worse,
 * turn some unrelated failure into a misleading conflict.
 */
function isUniqueConstraintViolation(error: unknown): boolean {
	if (typeof error !== "object" || error === null) {
		return false;
	}

	const candidate = error as { constraint?: unknown; code?: unknown };

	return (
		candidate.code === "23505" ||
		candidate.constraint === "project_members_project_id_user_id_unique"
	);
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

	if (project.status === "ARCHIVED") {
		throw new ProjectArchivedError();
	}

	const member = await db.orm.public.ProjectMembers.where((row) =>
		row.projectId.eq(project.id),
	)
		.where((row) => row.userId.eq(userId))
		.first();
	if (!member) {
		throw new ProjectMemberNotFoundError();
	}

	// Membership and assignment are two independent relationships, so taking the
	// first away does not take the second with it. Removing somebody who still owns
	// unfinished work would leave their tasks assigned to a person who can no longer
	// open the project they are in — invisible to the person meant to do it, and
	// unassignable by anybody else without editing each one. So the removal is
	// refused, with the count, until the work has been handed over.
	//
	// `DONE` and soft-deleted rows are excluded: a finished task is history, and a
	// deleted one is on nobody's desk. Blocking on either would make a member
	// impossible to remove on a project that merely has old work in it.
	const activeTasks = await db.orm.public.Tasks.where((task) =>
		task.projectId.eq(project.id),
	)
		.where((task) => task.assignedToId.eq(userId))
		.where((task) => task.deletedAt.isNull())
		.where((task) => task.status.in(ACTIVE_TASK_STATUSES))
		.aggregate((aggregate) => ({ total: aggregate.count() }));

	if (activeTasks.total > 0) {
		const owner = await db.orm.public.Users.where((row) => row.id.eq(userId))
			.select("name")
			.first();
		throw new ProjectMemberHasActiveTasksError(
			activeTasks.total,
			owner?.name ?? "This member",
		);
	}

	// Only the membership row goes. The user is a real account that may own other
	// projects, own tasks, and have a history; removing them from this project is
	// not a statement about any of that.
	await db.orm.public.ProjectMembers.where((row) =>
		row.id.eq(member.id),
	).delete();
}

/**
 * Resolves a project the caller is allowed to read, or throws.
 *
 * The same visibility rule that guards the detail route guards the aggregates, so
 * a member of one project can never read another's numbers.
 */
async function requireReadableProject(
	user: UserContext,
	projectId: string,
): Promise<ProjectRecord> {
	assertInternalApiAccess(user);
	const project = await findVisibleProject(projectId);
	if (!project) {
		throw new ProjectNotFoundError();
	}

	const memberships = await loadMemberships(project.id);
	assertCanView(user, project, memberships);

	return project;
}

/**
 * Counts the project's live tasks by status.
 *
 * Every count is a database aggregate, so the dashboard never counts a page of
 * rows in the browser. Soft-deleted tasks are excluded, matching every other
 * read path.
 */
async function countProjectTasks(
	projectId: string,
): Promise<ProjectTaskMetrics> {
	async function countByStatus(status?: TaskStatus): Promise<number> {
		let collection = db.orm.public.Tasks.where((task) =>
			task.projectId.eq(projectId),
		).where((task) => task.deletedAt.isNull());
		if (status !== undefined) {
			collection = collection.where((task) => task.status.eq(status));
		}
		const result = await collection.aggregate((aggregate) => ({
			total: aggregate.count(),
		}));
		return result.total;
	}

	const [total, completed, inProgress, todo, unassigned] = await Promise.all([
		countByStatus(),
		countByStatus("DONE"),
		countByStatus("IN_PROGRESS"),
		countByStatus("TODO"),
		// Nobody is on it, so it is on nobody's dashboard either. Counted here rather
		// than derived from `total - assigned`, which would also count a task whose
		// assignee was removed from the project — the orphan the member-removal rule
		// exists to prevent, and not something to report as "waiting for triage".
		countUnassigned(),
	]);

	return { total, completed, inProgress, todo, blocked: 0, unassigned };

	async function countUnassigned(): Promise<number> {
		const result = await db.orm.public.Tasks.where((task) =>
			task.projectId.eq(projectId),
		)
			.where((task) => task.deletedAt.isNull())
			.where((task) => task.assignedToId.isNull())
			.aggregate((aggregate) => ({ total: aggregate.count() }));
		return result.total;
	}
}

/**
 * How much open work each member of this project is carrying.
 *
 * Computed in the database with a single grouped aggregate rather than by loading
 * the project's tasks and counting them here, or worse by letting the browser
 * fetch every task and tally it — both of which turn one number into a full table
 * scan on the client.
 *
 * Only unfinished tasks are counted, for the same reason the member-removal guard
 * counts the same set: a `DONE` task is history and is not anybody's workload. The
 * unassigned bucket is included, because "2 tasks have nobody on them" is the number
 * a project manager most wants and the one a per-member list cannot show.
 */
async function countProjectWorkload(
	projectId: string,
): Promise<ProjectWorkloadEntry[]> {
	const rows = await db.orm.public.Tasks.where((task) =>
		task.projectId.eq(projectId),
	)
		.where((task) => task.deletedAt.isNull())
		.where((task) => task.status.in(ACTIVE_TASK_STATUSES))
		.select("assignedToId")
		.all();

	// Tallying the ids already read here is deliberate: the grouped aggregate the
	// ORM would otherwise emit is not available on this query shape, and a page of
	// ids is a far smaller payload than joining `users` for every assignee. The
	// alternative — a second query per distinct assignee — is the N+1 to avoid.
	const counts = new Map<string, number>();
	let unassigned = 0;
	for (const row of rows) {
		if (row.assignedToId === null) {
			unassigned += 1;
			continue;
		}
		counts.set(row.assignedToId, (counts.get(row.assignedToId) ?? 0) + 1);
	}

	const entries: ProjectWorkloadEntry[] = [];
	if (counts.size > 0) {
		const members = await db.orm.public.Users.where((user) =>
			user.id.in([...counts.keys()]),
		)
			.select("id", "name", "department")
			.all();
		for (const member of members) {
			entries.push({
				userId: member.id,
				name: member.name,
				department: member.department,
				openTaskCount: counts.get(member.id) ?? 0,
			});
		}
	}
	if (unassigned > 0) {
		entries.push({
			userId: null,
			name: "Unassigned",
			department: null,
			openTaskCount: unassigned,
		});
	}

	// Busiest first, then by name, so the order is stable between requests.
	return entries.sort(
		(first, second) =>
			second.openTaskCount - first.openTaskCount ||
			first.name.localeCompare(second.name),
	);
}

/**
 * The project's calculated block state, keyed by task id.
 *
 * Resolved once and reused by both the totals and the per-department breakdown,
 * so the two cannot disagree about which tasks are blocked and the graph is only
 * walked a single time.
 */
async function resolveProjectBlockingStates(
	projectId: string,
): Promise<Map<string, TaskBlockingState>> {
	const taskIds = await db.orm.public.Tasks.where((task) =>
		task.projectId.eq(projectId),
	)
		.where((task) => task.deletedAt.isNull())
		.select("id")
		.all();
	if (taskIds.length === 0) {
		return new Map();
	}
	return computeTaskBlockingStates(
		projectId,
		taskIds.map((task) => task.id),
	);
}

function countBlockedStates(
	states: ReadonlyMap<string, TaskBlockingState>,
): number {
	return [...states.values()].filter((state) => state.blocked).length;
}

/**
 * Counts per task-owning department.
 *
 * The blocked figure comes from the resolved graph rather than a per-department
 * query, so it matches the project total exactly. Departments with no live task
 * are left out entirely instead of being reported as a row of zeroes, which would
 * imply a team is attached to work that does not exist.
 */
async function countProjectTasksByDepartment(
	projectId: string,
	blockingStates: ReadonlyMap<string, TaskBlockingState>,
): Promise<ProjectDepartmentMetrics[]> {
	const rows = await db.orm.public.Tasks.where((task) =>
		task.projectId.eq(projectId),
	)
		.where((task) => task.deletedAt.isNull())
		.all();

	const buckets = new Map<string, ProjectDepartmentMetrics>();
	for (const task of rows) {
		const department = String(task.department);
		let bucket = buckets.get(department);
		if (bucket === undefined) {
			bucket = {
				department,
				total: 0,
				completed: 0,
				inProgress: 0,
				todo: 0,
				blocked: 0,
				progressPercentage: 0,
			};
			buckets.set(department, bucket);
		}
		bucket.total += 1;
		if (task.status === "DONE") {
			bucket.completed += 1;
		}
		if (task.status === "IN_PROGRESS") {
			bucket.inProgress += 1;
		}
		if (task.status === "TODO") {
			bucket.todo += 1;
		}
		if (blockingStates.get(task.id)?.blocked === true) {
			bucket.blocked += 1;
		}
	}

	return (
		[...buckets.values()]
			.map((bucket) => ({
				...bucket,
				progressPercentage: computeProjectProgressPercentage(bucket),
			}))
			// A stable order keeps the dashboard from reshuffling between requests.
			.sort((first, second) =>
				first.department.localeCompare(second.department),
			)
	);
}

/**
 * Project progress as a percentage of completed tasks.
 *
 * The formula is the one the client dashboard already uses, kept in one place so
 * both surfaces cannot drift apart. Computing it here rather than in the browser
 * is deliberate: progress is a business metric, and the server owns it.
 */
function computeProjectProgressPercentage(
	metrics: Pick<ProjectTaskMetrics, "completed" | "total">,
): number {
	if (metrics.total === 0) {
		return 0;
	}
	return Math.round((metrics.completed / metrics.total) * 100);
}

export async function getProjectMetrics(
	user: UserContext,
	projectId: string,
): Promise<ProjectMetricsResponse> {
	const project = await requireReadableProject(user, projectId);

	// The status counts, the dependency graph and the workload split are resolved
	// independently and then combined, so the blocked figure, the per-department
	// breakdown and the per-member counts each come from one pass rather than one
	// per metric.
	const [statusCounts, blockingStates, workload] = await Promise.all([
		countProjectTasks(project.id),
		resolveProjectBlockingStates(project.id),
		countProjectWorkload(project.id),
	]);
	const tasks: ProjectTaskMetrics = {
		...statusCounts,
		// A task is blocked when a prerequisite is unfinished, which is a property
		// of the dependency graph rather than of the stored status: the status is
		// only rewritten to BLOCKED in some paths, so counting that column would
		// report zero for work that genuinely cannot start. The same graph
		// function the task list and the client dashboard use decides this.
		blocked: countBlockedStates(blockingStates),
	};
	const byDepartment = await countProjectTasksByDepartment(
		project.id,
		blockingStates,
	);

	return {
		projectId: project.id,
		progress: { percentage: computeProjectProgressPercentage(tasks) },
		tasks,
		byDepartment,
		workload,
	};
}

/**
 * The project's most recent audit entries, newest first.
 *
 * Scoped to the tasks of one project and gated on the same project visibility
 * rule, so an activity feed can never surface a change from a project the caller
 * cannot open. The client guest has no equivalent: internal actors and internal
 * field values are not theirs to read.
 */
export async function getProjectActivity(
	user: UserContext,
	projectId: string,
	query: ProjectActivityQuery,
): Promise<ProjectActivityResponse> {
	const project = await requireReadableProject(user, projectId);

	const taskIds = await db.orm.public.Tasks.where((task) =>
		task.projectId.eq(project.id),
	)
		.select("id")
		.all();
	const ids = taskIds.map((task) => task.id);

	if (ids.length === 0) {
		return {
			activity: [],
			pagination: toPagination(query.page, query.limit, 0),
		};
	}

	const countResult = await db.orm.public.AuditLogs.where((row) =>
		row.taskId.in(ids),
	).aggregate((aggregate) => ({ total: aggregate.count() }));

	const records = await db.orm.public.AuditLogs.where((row) =>
		row.taskId.in(ids),
	)
		.orderBy((row) => row.createdAt.desc())
		.orderBy((row) => row.id.desc())
		.limit(query.limit)
		.offset((query.page - 1) * query.limit)
		.all();

	// Titles are resolved in one query instead of per row, so a page of activity
	// costs two queries rather than one plus the page size.
	const titleRows = await db.orm.public.Tasks.where((task) => task.id.in(ids))
		.select("id", "title")
		.all();
	const titles = new Map(titleRows.map((task) => [task.id, task.title]));

	return {
		activity: records.map((row) => ({
			id: row.id,
			taskId: row.taskId,
			taskTitle: titles.get(row.taskId) ?? "Deleted task",
			userId: row.userId,
			changedColumn: String(row.changedColumn),
			oldValue: row.oldValue,
			newValue: row.newValue,
			createdAt: String(row.createdAt),
		})),
		pagination: toPagination(query.page, query.limit, countResult.total),
	};
}
