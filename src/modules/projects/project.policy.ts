import {
	authorizationService,
	hasAnyRole,
	hasPermission,
} from "../authorization/authorization.service";
import type {
	ProjectAuthorizationContext,
	UserContext,
} from "../authorization/authorization.types";
import { Permission } from "../authorization/authorization.types";

/**
 * The internal project module exposes the full project record, so it is limited
 * to internal roles. Client guests are served exclusively by the client module,
 * which returns sanitized payloads.
 */
export function canUseInternalProjectApi(user: UserContext): boolean {
	return hasAnyRole(user, ["PM", "INTERNAL"]);
}

export function canViewProject(
	user: UserContext,
	project: ProjectAuthorizationContext,
): boolean {
	return authorizationService.canAccessProject({ user, project });
}

export function canCreateProject(user: UserContext): boolean {
	return hasPermission(user, Permission.PROJECT_CREATE);
}

export function canUpdateProject(user: UserContext): boolean {
	return hasPermission(user, Permission.PROJECT_UPDATE);
}

export function canDeleteProject(user: UserContext): boolean {
	return hasPermission(user, Permission.PROJECT_DELETE);
}

export function canManageProjectMembers(user: UserContext): boolean {
	return authorizationService.hasRole(user, "PM");
}
