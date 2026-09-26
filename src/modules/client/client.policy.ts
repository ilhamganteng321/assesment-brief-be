import {
	authorizationService,
	hasRole,
} from "../authorization/authorization.service";
import type {
	ProjectAuthorizationContext,
	TaskAuthorizationContext,
	UserContext,
} from "../authorization/authorization.types";

export function canAccessClientApi(user: UserContext): boolean {
	return hasRole(user, "CLIENT");
}

export function canViewClientDashboard(user: UserContext): boolean {
	return canAccessClientApi(user);
}

export function canAccessClientProject(
	user: UserContext,
	project: ProjectAuthorizationContext,
): boolean {
	return (
		canAccessClientApi(user) &&
		authorizationService.canAccessProject({ user, project })
	);
}

export function canViewClientTask(input: {
	user: UserContext;
	task: TaskAuthorizationContext;
	project: ProjectAuthorizationContext;
}): boolean {
	const { user, task, project } = input;
	return canAccessClientProject(user, project) && task.clientVisible;
}

export function canViewClientAuditLogs(_user: UserContext): boolean {
	return false;
}
