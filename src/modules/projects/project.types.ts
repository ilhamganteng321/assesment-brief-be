import type { Models } from "../../prisma/contract";

/**
 * A project row with its relations dropped.
 *
 * The `Omit` list is exhaustive on purpose and is the reason several services
 * declare the same shape locally. Adding a relation to the contract is a compile
 * error in every one of them until the name is added here too, which is a
 * feature: a new relation cannot slip into a row that the response builders treat
 * as flat scalar data. `invitations` joined that list when project invitations
 * shipped.
 */
export type ProjectRecord = Omit<
	Models.public_Projects,
	"members" | "tasks" | "invitations"
>;

export type ProjectMemberRecord = Omit<
	Models.public_ProjectMembers,
	"project" | "user"
>;

export type ProjectMemberWithUser = ProjectMemberRecord & {
	user: ProjectMemberUserSummary;
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
	user: ProjectMemberUserSummary;
};

/**
 * The user fields a member row is allowed to carry.
 *
 * An allow-list projection, so `passwordHash` and any future column on `users`
 * cannot reach the member list or the candidate search by being selected. Every
 * field here is something the member-management interface actually renders: who
 * the person is, what they may do, and which team they belong to.
 *
 * The global `role` is authoritative and is included deliberately — the prompt to
 * add a member has to show what a person will be able to do once they are on the
 * project, and that is the only place the product stores it.
 */
export type ProjectMemberUserSummary = {
	id: string;
	name: string;
	email: string;
	role: string;
	department: string;
};

/**
 * One user the caller could add to this project.
 *
 * `alreadyMember` is reported rather than filtered out, because "why is John not
 * in this list" is a worse answer than "John is already on the project". The
 * interface marks the row instead of offering it, and the write path still
 * refuses a duplicate independently.
 */
export type ProjectMemberCandidateResponse = ProjectMemberUserSummary & {
	alreadyMember: boolean;
};

export type ProjectMemberCandidatesResponse = {
	candidates: ProjectMemberCandidateResponse[];
	pagination: Pagination;
};

export type ProjectListResponse = {
	projects: ProjectListItem[];
	pagination: Pagination;
};

/**
 * One row of the project list: the project plus the headline figure a reader
 * needs before opening it.
 *
 * The progress percentage is computed by the server from the same aggregate the
 * project metrics endpoint uses, so a list can never show a different number
 * from the project it links to. It is a single grouped query over the page rather
 * than one metrics request per row.
 */
export type ProjectListItem = ProjectResponse & {
	progress: ProjectProgress;
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
	/**
	 * Live tasks with nobody on them.
	 *
	 * Reported separately rather than left to be inferred, because "work with no
	 * owner" is the number a project manager acts on and the one a client guest
	 * must never see — the client payload does not include this field at all.
	 */
	unassigned: number;
};

export type ProjectProgress = {
	percentage: number;
};

/** One task-owning department's counts within the project. */
export type ProjectDepartmentMetrics = {
	department: string;
	total: number;
	completed: number;
	inProgress: number;
	todo: number;
	blocked: number;
	/** Completed share as a whole percentage, computed by the server. */
	progressPercentage: number;
};

/**
 * One row of the workload split: who is carrying how much open work.
 *
 * `userId` is nullable rather than absent, because the unassigned bucket is a real
 * row with a real count and making it a separate field would mean the interface
 * renders two lists with different shapes. `department` is nullable for the same
 * reason and is the only field it is needed for — a client is told who is behind
 * and how much they are carrying, not who reports to whom.
 *
 * Names people, so this is internal-only: the metrics endpoint is not reachable by
 * a client guest, who reads the masked `/client/*` dashboard instead.
 */
export type ProjectWorkloadEntry = {
	userId: string | null;
	name: string;
	department: string | null;
	/** Unfinished, non-deleted tasks. */
	openTaskCount: number;
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
	/**
	 * Per-department breakdown, computed from the same aggregates as the totals.
	 *
	 * Departments that own no live task are omitted rather than reported as zero,
	 * so a client cannot infer that a team exists in the project from an empty
	 * row. The client guest never receives this at all.
	 */
	byDepartment: ProjectDepartmentMetrics[];
	/**
	 * Open work per member, busiest first, including an unassigned row.
	 *
	 * Only people with at least one unfinished task appear: a member with none is
	 * absent rather than reported as zero, so the split cannot be used to enumerate
	 * the roster of a project.
	 */
	workload: ProjectWorkloadEntry[];
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
