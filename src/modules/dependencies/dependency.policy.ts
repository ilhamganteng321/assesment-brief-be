import {
	authorizationService,
	hasPermission,
} from "../authorization/authorization.service";
import type {
	ProjectAuthorizationContext,
	TaskAuthorizationContext,
	UserContext,
} from "../authorization/authorization.types";
import { Permission } from "../authorization/authorization.types";

export function canViewDependencies(
	user: UserContext,
	task: TaskAuthorizationContext,
	project: ProjectAuthorizationContext,
): boolean {
	return authorizationService.canViewTask({ user, task, project });
}

export function canCreateDependency(user: UserContext): boolean {
	return hasPermission(user, Permission.TASK_DEPENDENCY_CREATE);
}

export function canDeleteDependency(user: UserContext): boolean {
	return hasPermission(user, Permission.TASK_DEPENDENCY_DELETE);
}
