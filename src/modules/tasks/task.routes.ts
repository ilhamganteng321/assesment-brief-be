import type { Context } from "hono";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { JSON_BODY_LIMIT_BYTES } from "../../config/limits";
import { HttpError } from "../../lib/http-error";
import { errorResponse, successResponse } from "../../lib/response";
import type { AuthVariables } from "../../middleware/auth";
import { authRequired } from "../../middleware/auth";
import type { RequestIdVariables } from "../../middleware/request-id";
import {
	flatTaskIdParamSchema,
	projectIdParamSchema,
	taskDeleteQuerySchema,
	taskIdParamSchema,
	taskListQuerySchema,
	taskOfficialListQuerySchema,
} from "./task.schema";
import {
	createTask,
	createTaskForProject,
	getTask,
	getTaskById,
	listAllTasks,
	listMyTasks,
	listTasks,
	softDeleteTask,
	softDeleteTaskById,
	updateTask,
	updateTaskById,
} from "./task.service";

type TaskRoutesVariables = RequestIdVariables & AuthVariables;

export const taskRoutes = new Hono<{
	Variables: TaskRoutesVariables;
}>();

taskRoutes.use("*", authRequired);

taskRoutes.use(
	"*",
	bodyLimit({
		maxSize: JSON_BODY_LIMIT_BYTES,
		onError: (c) =>
			c.json(
				errorResponse(
					"PAYLOAD_TOO_LARGE",
					"Request body is too large",
					c.get("requestId"),
				),
				413,
			),
	}),
);

async function readJson(c: Context): Promise<unknown> {
	try {
		return await c.req.json();
	} catch {
		throw new HttpError(
			400,
			"INVALID_REQUEST",
			"Request body must be valid JSON",
		);
	}
}

taskRoutes.get("/:projectId/tasks", async (c) => {
	const { projectId } = projectIdParamSchema.parse(c.req.param());
	const query = taskListQuerySchema.parse(c.req.query());
	const result = await listTasks(c.get("user"), projectId, query);
	return c.json(successResponse(result));
});

taskRoutes.post("/:projectId/tasks", async (c) => {
	const { projectId } = projectIdParamSchema.parse(c.req.param());
	const task = await createTask(c.get("user"), projectId, await readJson(c));
	return c.json(successResponse({ task }), 201);
});

taskRoutes.get("/:projectId/tasks/:taskId", async (c) => {
	const { projectId, taskId } = taskIdParamSchema.parse(c.req.param());
	const task = await getTask(c.get("user"), projectId, taskId);
	return c.json(successResponse({ task }));
});

taskRoutes.patch("/:projectId/tasks/:taskId", async (c) => {
	const { projectId, taskId } = taskIdParamSchema.parse(c.req.param());
	const task = await updateTask(
		c.get("user"),
		projectId,
		taskId,
		await readJson(c),
	);
	return c.json(successResponse({ task }));
});

taskRoutes.delete("/:projectId/tasks/:taskId", async (c) => {
	const { projectId, taskId } = taskIdParamSchema.parse(c.req.param());
	const { version } = taskDeleteQuerySchema.parse(c.req.query());
	await softDeleteTask(c.get("user"), projectId, taskId, version);
	return c.body(null, 204);
});

/**
 * Cross-project task surface mounted at `/tasks`.
 *
 * The nested project-scoped routes above stay in place for project work; these
 * routes exist so the task list can span projects while still applying the same
 * membership rule. Clients are rejected here and keep using `/client`.
 */
export const flatTaskRoutes = new Hono<{
	Variables: TaskRoutesVariables;
}>();

flatTaskRoutes.use("*", authRequired);

flatTaskRoutes.use(
	"*",
	bodyLimit({
		maxSize: JSON_BODY_LIMIT_BYTES,
		onError: (c) =>
			c.json(
				errorResponse(
					"PAYLOAD_TOO_LARGE",
					"Request body is too large",
					c.get("requestId"),
				),
				413,
			),
	}),
);

flatTaskRoutes.get("/", async (c) => {
	const query = taskOfficialListQuerySchema.parse(c.req.query());
	const result = await listAllTasks(c.get("user"), query);
	return c.json(successResponse(result));
});

/**
 * The caller's own work, across every project they can reach.
 *
 * Registered before `/:taskId` so the literal wins: Hono matches in registration
 * order, and a route declared afterwards would see `/tasks/my` as a task id and
 * reject it with a validation error about a uuid. The same reason the candidate
 * search is registered ahead of the member routes it would otherwise shadow.
 *
 * There is no `userId` parameter. The assignee is the verified JWT's subject, so
 * this cannot be pointed at somebody else's work — see `listMyTasks`.
 */
flatTaskRoutes.get("/my", async (c) => {
	const query = taskOfficialListQuerySchema.parse(c.req.query());
	const result = await listMyTasks(c.get("user"), query);
	return c.json(successResponse(result));
});

flatTaskRoutes.post("/", async (c) => {
	const task = await createTaskForProject(c.get("user"), await readJson(c));
	return c.json(successResponse({ task }), 201);
});

flatTaskRoutes.get("/:taskId", async (c) => {
	const { taskId } = flatTaskIdParamSchema.parse(c.req.param());
	const task = await getTaskById(c.get("user"), taskId);
	return c.json(successResponse({ task }));
});

flatTaskRoutes.patch("/:taskId", async (c) => {
	const { taskId } = flatTaskIdParamSchema.parse(c.req.param());
	const task = await updateTaskById(c.get("user"), taskId, await readJson(c));
	return c.json(successResponse({ task }));
});

flatTaskRoutes.delete("/:taskId", async (c) => {
	const { taskId } = flatTaskIdParamSchema.parse(c.req.param());
	const { version } = taskDeleteQuerySchema.parse(c.req.query());
	await softDeleteTaskById(c.get("user"), taskId, version);
	return c.body(null, 204);
});
