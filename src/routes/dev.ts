import { Hono } from "hono";
import { successResponse } from "../lib/response";
import type { AuthVariables } from "../middleware/auth";
import { authRequired } from "../middleware/auth";
import type { RequestIdVariables } from "../middleware/request-id";
import {
	requirePermission,
	requireRole,
} from "../modules/authorization/authorization.middleware";
import { hasPermission } from "../modules/authorization/authorization.service";
import {
	PERMISSION_MATRIX,
	Permission,
} from "../modules/authorization/authorization.types";

type DevRoutesVariables = RequestIdVariables & AuthVariables;

export const devRoutes = new Hono<{ Variables: DevRoutesVariables }>();

const ALL_PERMISSIONS = Object.values(Permission);

devRoutes.get("/authz/permissions", authRequired, (c) => {
	const user = c.get("user");
	const permissions = ALL_PERMISSIONS.filter((permission) =>
		hasPermission(user, permission),
	);
	return c.json(
		successResponse({ user, permissions, matrix: PERMISSION_MATRIX }),
	);
});

devRoutes.get(
	"/authz/task-read",
	authRequired,
	requirePermission(Permission.TASK_READ),
	(c) => c.json(successResponse({ message: "TASK_READ granted" })),
);

devRoutes.post(
	"/authz/task-create",
	authRequired,
	requirePermission(Permission.TASK_CREATE),
	(c) =>
		c.json(
			successResponse({
				message: "TASK_CREATE granted (dev-only stub, no task is created)",
			}),
			201,
		),
);

devRoutes.get("/authz/audit-pm", authRequired, requireRole("PM"), (c) =>
	c.json(successResponse({ message: "PM role granted" })),
);
