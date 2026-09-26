import {
	authorizationService,
	hasPermission,
} from "../authorization/authorization.service";
import type {
	ProjectAuthorizationContext,
	TaskAuthorizationContext,
	TaskStatus,
	UserContext,
} from "../authorization/authorization.types";
import { Permission } from "../authorization/authorization.types";

export function canViewTask(
	user: UserContext,
	task: TaskAuthorizationContext,
	project: ProjectAuthorizationContext,
): boolean {
	return authorizationService.canViewTask({ user, task, project });
}

export function canAccessProjectTasks(
	user: UserContext,
	project: ProjectAuthorizationContext,
): boolean {
	return authorizationService.canAccessProject({ user, project });
}

export function canCreateTask(user: UserContext): boolean {
	return hasPermission(user, Permission.TASK_CREATE);
}

export function canEditTask(
	user: UserContext,
	task: TaskAuthorizationContext,
	project: ProjectAuthorizationContext,
): boolean {
	return authorizationService.canEditTask({ user, task, project });
}

export function canEditTaskDescription(user: UserContext): boolean {
	return authorizationService.canEditTaskDescription({ user });
}

export function canDeleteTask(user: UserContext): boolean {
	return hasPermission(user, Permission.TASK_DELETE);
}

export function canChangeAssignment(user: UserContext): boolean {
	return authorizationService.canAssignTask({ user });
}

export function canChangeTaskStatus(
	user: UserContext,
	task: TaskAuthorizationContext,
	targetStatus: TaskStatus,
): boolean {
	return authorizationService.canChangeTaskStatus({ user, task, targetStatus });
}

export function canChangeClientVisibility(user: UserContext): boolean {
	return authorizationService.hasRole(user, "PM");
}

/**
 * Priority and department define who owns a task and how urgent it is, so they
 * stay under PM control. Internal users may still drive status and assignment
 * flow without being able to redefine ownership.
 */
export function canEditTaskMetadata(user: UserContext): boolean {
	return authorizationService.hasRole(user, "PM");
}
