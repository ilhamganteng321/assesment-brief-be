import { hasPermission } from "../authorization/authorization.service";
import type { UserContext } from "../authorization/authorization.types";
import { Permission } from "../authorization/authorization.types";

/**
 * Who may read the organisation-wide user directory.
 *
 * One permission rather than a role check, so the gate lives in a single place
 * and widening it to another role later is a matrix edit rather than a sweep
 * through services and routes. See `Permission.USER_READ` for why PM holds it and
 * the other two roles do not.
 */
export function canListUsers(user: UserContext): boolean {
	return hasPermission(user, Permission.USER_READ);
}

/**
 * Who may read one user.
 *
 * The same gate as the list. It is spelled out separately rather than delegating,
 * so the two decisions can diverge later without this becoming a lie — reading a
 * single profile is the shape most likely to need a narrower rule than browsing
 * everything, and it should not take editing the list to find that out.
 */
export function canViewUser(user: UserContext): boolean {
	return hasPermission(user, Permission.USER_READ);
}

/**
 * The columns a caller may see about another user.
 *
 * A single answer for every caller that passes the gate, and it is the whole
 * non-secret row. Stated as a function rather than inlined into a serializer so
 * the question "what can this role see about a person" has one answer to read,
 * and so narrowing it later is a change in one place.
 */
export function getVisibleUserFields(
	_user: UserContext,
): readonly (keyof import("./user.dto").UserSummary)[] {
	return ["id", "name", "email", "role", "department", "createdAt"];
}
