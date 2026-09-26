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

const INTERNAL_PERMISSIONS: readonly Permission[] = [
	Permission.TASK_READ,
	Permission.TASK_UPDATE,
	Permission.TASK_STATUS_CHANGE,
	Permission.AUDIT_READ,
];

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
