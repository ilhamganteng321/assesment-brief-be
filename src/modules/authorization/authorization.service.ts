import type {
	ProjectAuthorizationContext,
	TaskAuthorizationContext,
	TaskDependencyContext,
	TaskStatus,
	UserContext,
	UserRole,
} from "./authorization.types";
import { PERMISSION_MATRIX, Permission } from "./authorization.types";

export function hasRole(user: UserContext, role: UserRole): boolean {
	return user.role === role;
}

export function hasAnyRole(
	user: UserContext,
	roles: readonly UserRole[],
): boolean {
	return roles.some((role) => user.role === role);
}

export function hasPermission(
	user: UserContext,
	permission: Permission,
): boolean {
	return PERMISSION_MATRIX[user.role].includes(permission);
}

function isProjectMember(
	user: UserContext,
	project: ProjectAuthorizationContext,
): boolean {
	return project.memberships.some(
		(membership) => membership.userId === user.id,
	);
}

export function canAccessProject(input: {
	user: UserContext;
	project: ProjectAuthorizationContext;
}): boolean {
	const { user, project } = input;

	if (user.role === "PM") {
		return hasPermission(user, Permission.PROJECT_READ);
	}

	if (user.role === "CLIENT") {
		return isProjectMember(user, project);
	}

	return (
		hasPermission(user, Permission.TASK_READ) && isProjectMember(user, project)
	);
}

export function canViewTask(input: {
	user: UserContext;
	task: TaskAuthorizationContext;
	project: ProjectAuthorizationContext;
}): boolean {
	const { user, task, project } = input;

	if (user.role === "PM") {
		return hasPermission(user, Permission.TASK_READ);
	}

	if (user.role === "CLIENT") {
		return isProjectMember(user, project) && task.clientVisible;
	}

	return isProjectMember(user, project);
}

export function canEditTask(input: {
	user: UserContext;
	task: TaskAuthorizationContext;
	project: ProjectAuthorizationContext;
}): boolean {
	const { user, task } = input;

	if (user.role === "PM") {
		return hasPermission(user, Permission.TASK_UPDATE);
	}

	if (user.role === "CLIENT") {
		return false;
	}

	return (
		hasPermission(user, Permission.TASK_UPDATE) && task.assignedToId === user.id
	);
}

export function canEditTaskDescription(input: { user: UserContext }): boolean {
	return input.user.role === "PM";
}

export function canAssignTask(input: { user: UserContext }): boolean {
	return hasPermission(input.user, Permission.TASK_ASSIGN);
}

export function canManageDependencies(input: { user: UserContext }): boolean {
	return (
		hasPermission(input.user, Permission.TASK_DEPENDENCY_CREATE) &&
		hasPermission(input.user, Permission.TASK_DEPENDENCY_DELETE)
	);
}

export function canCompleteTask(input: {
	user: UserContext;
	task: { assignedToId: string | null };
}): boolean {
	const { user, task } = input;
	return task.assignedToId !== null && task.assignedToId === user.id;
}

export function canChangeTaskStatus(input: {
	user: UserContext;
	task: TaskAuthorizationContext;
	targetStatus: TaskStatus;
	dependencies?: TaskDependencyContext;
}): boolean {
	const { user, task, targetStatus } = input;

	if (!hasPermission(user, Permission.TASK_STATUS_CHANGE)) {
		return false;
	}

	if (targetStatus === "DONE" && task.status === "IN_PROGRESS") {
		return canCompleteTask({ user, task });
	}

	if (user.role === "INTERNAL") {
		return task.assignedToId === user.id;
	}

	return true;
}

export const authorizationService = {
	hasRole,
	hasAnyRole,
	hasPermission,
	canAccessProject,
	canViewTask,
	canEditTask,
	canEditTaskDescription,
	canAssignTask,
	canManageDependencies,
	canCompleteTask,
	canChangeTaskStatus,
};
