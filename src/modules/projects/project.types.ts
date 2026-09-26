import type { Models } from "../../prisma/contract";

export type ProjectRecord = Omit<Models.public_Projects, "members" | "tasks">;

export type ProjectMemberRecord = Omit<
	Models.public_ProjectMembers,
	"project" | "user"
>;

export type ProjectMemberWithUser = ProjectMemberRecord & {
	user: {
		id: Models.public_Users["id"];
		name: Models.public_Users["name"];
		email: Models.public_Users["email"];
		department: Models.public_Users["department"];
	};
};

export type Pagination = {
	page: number;
	limit: number;
	total: number;
	totalPages: number;
};

/**
 * Allow-listed project response. Database rows are never returned directly, so a
 * new column can never leak into the API without a deliberate decision here.
 */
export type ProjectResponse = {
	id: string;
	name: string;
	description: string | null;
	clientName: string | null;
	status: ProjectRecord["status"];
	createdAt: string;
	updatedAt: string;
};

export type ProjectMemberResponse = {
	id: string;
	projectId: string;
	userId: string;
	createdAt: string;
	user: {
		id: string;
		name: string;
		email: string;
		department: Models.public_Users["department"];
	};
};

export type ProjectListResponse = {
	projects: ProjectResponse[];
	pagination: Pagination;
};

/**
 * Task counts for one project, as the database counts them.
 *
 * `blocked` is derived from the dependency graph rather than the persisted
 * `BLOCKED` status, because a task whose prerequisite is unfinished has not had
 * its status rewritten to BLOCKED and would otherwise be missed.
 */
export type ProjectTaskMetrics = {
	total: number;
	completed: number;
	inProgress: number;
	todo: number;
	blocked: number;
};

export type ProjectProgress = {
	percentage: number;
};

/**
 * The aggregate view a project dashboard needs. Every number is produced by the
 * server so the client never has to invent a business rule for progress, and the
 * whole payload is withheld from a client guest, who reads `/client/*` instead.
 */
export type ProjectMetricsResponse = {
	projectId: string;
	progress: ProjectProgress;
	tasks: ProjectTaskMetrics;
};

/** One recent change, projected for a project-level activity feed. */
export type ProjectActivityEntry = {
	id: string;
	taskId: string;
	taskTitle: string;
	userId: string;
	changedColumn: string;
	oldValue: string | null;
	newValue: string | null;
	createdAt: string;
};

export type ProjectActivityResponse = {
	activity: ProjectActivityEntry[];
	pagination: Pagination;
};
