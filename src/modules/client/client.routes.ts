import { Hono } from "hono";
import { successResponse } from "../../lib/response";
import type { AuthVariables } from "../../middleware/auth";
import { authRequired } from "../../middleware/auth";
import type { RequestIdVariables } from "../../middleware/request-id";
import { ClientReadOnlyError } from "./client.errors";
import {
	clientProjectIdParamSchema,
	clientTaskIdParamSchema,
	clientTaskListQuerySchema,
} from "./client.schema";
import {
	getClientDashboard,
	getClientTask,
	listClientTasks,
} from "./client.service";

type ClientRoutesVariables = RequestIdVariables & AuthVariables;

export const clientRoutes = new Hono<{ Variables: ClientRoutesVariables }>();

clientRoutes.use("*", authRequired);

clientRoutes.get("/dashboard", async (c) => {
	const result = await getClientDashboard(c.get("user"));
	return c.json(successResponse(result));
});

clientRoutes.get("/projects/:projectId/tasks", async (c) => {
	const { projectId } = clientProjectIdParamSchema.parse(c.req.param());
	const query = clientTaskListQuerySchema.parse(c.req.query());
	const result = await listClientTasks(c.get("user"), projectId, query);
	return c.json(successResponse(result));
});

clientRoutes.get("/projects/:projectId/tasks/:taskId", async (c) => {
	const { projectId, taskId } = clientTaskIdParamSchema.parse(c.req.param());
	const task = await getClientTask(c.get("user"), projectId, taskId);
	return c.json(successResponse({ task }));
});

clientRoutes.on(["POST", "PUT", "PATCH", "DELETE"], "*", () => {
	throw new ClientReadOnlyError();
});
