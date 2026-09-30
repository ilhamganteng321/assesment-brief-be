import {
	authorizationService,
	hasAnyRole,
} from "../authorization/authorization.service";
import type { UserContext } from "../authorization/authorization.types";

/**
 * Who may manage a project's invitations.
 *
 * Exactly the same gate as adding a member, and by the same reasoning: an
 * invitation is a membership that has not happened yet, so whoever may create a
 * membership may create one of these. That also means the answer cannot drift
 * from the member flow's — a PM-only rule appears once, in the project policy,
 * and both features read it.
 *
 * Deliberately not a new permission. Role lives globally on the user, membership
 * is the project-scoped relationship, and this codebase has no per-project role
 * to hang an additional permission off. An internal engineer and a client guest
 * are both refused, by the server rather than by the interface.
 */
export function canManageProjectInvitations(user: UserContext): boolean {
	return authorizationService.hasRole(user, "PM");
}

/**
 * Who may use the internal project API at all.
 *
 * The project module exposes full project records, so it is limited to internal
 * roles; client guests are served exclusively by the client module. The
 * invitation routes are nested under that module, so they inherit the same
 * restriction and a client guest is refused twice over — once here, and again by
 * the role check above.
 */
export function canUseInvitationApi(user: UserContext): boolean {
	return hasAnyRole(user, ["PM", "INTERNAL"]);
}
