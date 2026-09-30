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

/**
 * Who may move a project through its lifecycle.
 *
 * Deliberately the same permission as editing the project, not a new one: a PM
 * who can rename a project can finish it, an internal engineer cannot do either,
 * and a client guest can do neither. The lifecycle therefore grants no role any
 * authority it did not already have — it only constrains *which* status a caller
 * who already may update can set.
 */
export function canChangeProjectStatus(user: UserContext): boolean {
	return hasPermission(user, Permission.PROJECT_UPDATE);
}

export function canDeleteProject(user: UserContext): boolean {
	return hasPermission(user, Permission.PROJECT_DELETE);
}

/**
 * Who may change a project's membership.
 *
 * PM only, and deliberately not expressed as a new permission: role lives
 * globally on the user, membership is the project-scoped relationship, and this
 * codebase has no per-project role to hang a permission off. An internal
 * engineer and a client guest are both refused, and both are refused by the
 * server rather than merely hidden by the interface.
 */
export function canManageProjectMembers(user: UserContext): boolean {
	return authorizationService.hasRole(user, "PM");
}

/**
 * Who may search for people to add.
 *
 * The same gate as adding, and that is the point: the candidate search exists
 * only to serve the "add member" flow, so it is not a user directory. Handing
 * it to a role that cannot act on the results would expose the whole
 * organisation's names, emails and departments to anyone who could reach a
 * project they belong to, which is a strictly larger disclosure than the
 * feature needs and no part of the product asks for.
 *
 * A client guest is refused here twice over — once by the role check, and again
 * by the project module refusing the internal API to clients at all.
 */
export function canSearchProjectMemberCandidates(user: UserContext): boolean {
	return canManageProjectMembers(user);
}
