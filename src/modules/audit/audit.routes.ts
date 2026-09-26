import { Hono } from "hono";
import { successResponse } from "../../lib/response";
import type { AuthVariables } from "../../middleware/auth";
import { authRequired } from "../../middleware/auth";
import type { RequestIdVariables } from "../../middleware/request-id";
import { taskIdParamSchema } from "../tasks/task.schema";
import { auditListQuerySchema } from "./audit.schema";
import { getTaskAuditLogs } from "./audit.service";

type AuditRoutesVariables = RequestIdVariables & AuthVariables;

export const auditRoutes = new Hono<{ Variables: AuditRoutesVariables }>();

auditRoutes.use("*", authRequired);

auditRoutes.get("/:projectId/tasks/:taskId/audit-logs", async (c) => {
	const { projectId, taskId } = taskIdParamSchema.parse(c.req.param());
	const query = auditListQuerySchema.parse(c.req.query());
	const result = await getTaskAuditLogs(
		c.get("user"),
		projectId,
		taskId,
		query,
	);
	return c.json(successResponse(result));
});
