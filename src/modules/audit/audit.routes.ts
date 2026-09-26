import { Hono } from "hono";
import { successResponse } from "../../lib/response";
import type { AuthVariables } from "../../middleware/auth";
import { authRequired } from "../../middleware/auth";
import type { RequestIdVariables } from "../../middleware/request-id";
import { taskIdParamSchema } from "../tasks/task.schema";
import { AuditAccessDeniedError } from "./audit.errors";
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

// The audit log is append-only, and that is a property worth enforcing rather
// than leaving to the absence of a write route. Without this, adding a
// mutating handler by mistake would quietly make history editable, and nothing
// would object.
//
// The path is named explicitly instead of `*` because this router is mounted at
// `/projects`, so a catch-all would also swallow the attachment, dependency and
// task routes mounted under the same prefix.
const auditLogPath = "/:projectId/tasks/:taskId/audit-logs";

auditRoutes.on(["POST", "PUT", "PATCH", "DELETE"], auditLogPath, () => {
	throw new AuditAccessDeniedError("Audit history is immutable");
});
