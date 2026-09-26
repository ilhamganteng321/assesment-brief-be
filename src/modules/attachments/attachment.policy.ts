import {
	authorizationService,
	hasAnyRole,
} from "../authorization/authorization.service";
import type {
	ProjectAuthorizationContext,
	UserContext,
} from "../authorization/authorization.types";

export function canAccessProjectAttachments(
	user: UserContext,
	project: ProjectAuthorizationContext,
): boolean {
	if (user.role === "CLIENT") {
		return false;
	}
	return authorizationService.canAccessProject({ user, project });
}

export function canUploadAttachment(user: UserContext): boolean {
	return hasAnyRole(user, ["PM", "INTERNAL"]);
}
