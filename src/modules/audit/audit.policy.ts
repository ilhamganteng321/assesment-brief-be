import {
	authorizationService,
	hasPermission,
} from "../authorization/authorization.service";
import type {
	ProjectAuthorizationContext,
	UserContext,
} from "../authorization/authorization.types";
import { Permission } from "../authorization/authorization.types";

export function canViewTaskAuditLogs(
	user: UserContext,
	project: ProjectAuthorizationContext,
): boolean {
	return (
		hasPermission(user, Permission.AUDIT_READ) &&
		authorizationService.canAccessProject({ user, project })
	);
}
