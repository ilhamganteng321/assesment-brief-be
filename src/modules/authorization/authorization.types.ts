import type { Models } from "../../prisma/contract.d";

export type UserRole = Models.public_Users["role"];
export type Department = Models.public_Users["department"];
export type ProjectStatus = Models.public_Projects["status"];
export type TaskStatus = Models.public_Tasks["status"];

export type UserContext = {
	id: string;
	role: UserRole;
	department: Department;
};

export const Permission = {
	PROJECT_READ: "PROJECT_READ",
	PROJECT_CREATE: "PROJECT_CREATE",
	PROJECT_UPDATE: "PROJECT_UPDATE",
	PROJECT_DELETE: "PROJECT_DELETE",
	/**
	 * Read the organisation-wide user directory.
	 *
	 * A real permission rather than a `role === "PM"` check scattered through the
	 * users module, so the gate is one matrix entry that can be widened to another
	 * role later without touching any service or route. Held by PM alone today:
	 * the directory exists so a project manager can find somebody to put on a
	 * project, and no other role has that job. An internal engineer can already
	 * see the members of their own projects, which is the subset they need.
	 */
	USER_READ: "USER_READ",
	TASK_READ: "TASK_READ",
	TASK_CREATE: "TASK_CREATE",
	TASK_UPDATE: "TASK_UPDATE",
	TASK_DELETE: "TASK_DELETE",
	TASK_ASSIGN: "TASK_ASSIGN",
	TASK_STATUS_CHANGE: "TASK_STATUS_CHANGE",
	TASK_DEPENDENCY_CREATE: "TASK_DEPENDENCY_CREATE",
	TASK_DEPENDENCY_DELETE: "TASK_DEPENDENCY_DELETE",
	AUDIT_READ: "AUDIT_READ",
} as const;

export type Permission = (typeof Permission)[keyof typeof Permission];

const PM_PERMISSIONS: readonly Permission[] = [
	Permission.PROJECT_READ,
	Permission.PROJECT_CREATE,
	Permission.PROJECT_UPDATE,
	Permission.PROJECT_DELETE,
	Permission.USER_READ,
	Permission.TASK_READ,
	Permission.TASK_CREATE,
	Permission.TASK_UPDATE,
	Permission.TASK_DELETE,
	Permission.TASK_ASSIGN,
	Permission.TASK_STATUS_CHANGE,
	Permission.TASK_DEPENDENCY_CREATE,
	Permission.TASK_DEPENDENCY_DELETE,
	Permission.AUDIT_READ,
];

/**
 * Deliberately without `USER_READ`.
 *
 * An internal user is a team member, not an administrator of the org chart: they
 * can see the members of the projects they belong to, which is the subset of the
 * directory their work actually touches. Granting every engineer a searchable
 * list of every account, email and department would be a wider disclosure than
 * any part of the product asks for. Widening this is a one-line matrix change
 * when a real need appears.
 */
const INTERNAL_PERMISSIONS: readonly Permission[] = [
	Permission.TASK_READ,
	Permission.TASK_UPDATE,
	Permission.TASK_STATUS_CHANGE,
	Permission.AUDIT_READ,
];

/**
 * No `USER_READ`, and the reason is the point: a client guest must not be able
 * to enumerate the internal team. `PROJECT_READ` is scoped to projects they are a
 * member of, and they are never a member of an internal project. A client learns
 * about people only through the project they are on, and even there the existing
 * client policy exposes no member identities at all.
 */
const CLIENT_PERMISSIONS: readonly Permission[] = [
	Permission.PROJECT_READ,
	Permission.TASK_READ,
];

export const PERMISSION_MATRIX: Readonly<
	Record<UserRole, readonly Permission[]>
> = {
	PM: PM_PERMISSIONS,
	INTERNAL: INTERNAL_PERMISSIONS,
	CLIENT: CLIENT_PERMISSIONS,
};

export type ProjectAuthorizationContext = {
	readonly id: string;
	readonly status: ProjectStatus;
	readonly memberships: readonly {
		readonly userId: string;
	}[];
};

export type TaskAuthorizationContext = {
	readonly id: string;
	readonly projectId: string;
	readonly status: TaskStatus;
	readonly assignedToId: string | null;
	readonly clientVisible: boolean;
};

export type TaskDependencyContext = {
	readonly dependencies: readonly {
		readonly taskId: string;
		readonly status: TaskStatus;
	}[];
};
