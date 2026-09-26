import { createMiddleware } from "hono/factory";
import type { AuthVariables } from "../../middleware/auth";
import { ForbiddenError } from "./authorization.errors";
import { hasAnyRole, hasPermission, hasRole } from "./authorization.service";
import type { Permission, UserRole } from "./authorization.types";

export const requirePermission = (permission: Permission) =>
	createMiddleware<{ Variables: AuthVariables }>(async (c, next) => {
		const user = c.get("user");
		if (!hasPermission(user, permission)) {
			throw new ForbiddenError();
		}
		await next();
	});

export const requireRole = (role: UserRole) =>
	createMiddleware<{ Variables: AuthVariables }>(async (c, next) => {
		const user = c.get("user");
		if (!hasRole(user, role)) {
			throw new ForbiddenError();
		}
		await next();
	});

export const requireAnyRole = (roles: readonly UserRole[]) =>
	createMiddleware<{ Variables: AuthVariables }>(async (c, next) => {
		const user = c.get("user");
		if (!hasAnyRole(user, roles)) {
			throw new ForbiddenError();
		}
		await next();
	});
