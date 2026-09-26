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
	dependencyDeleteParamsSchema,
	dependentTaskParamsSchema,
	flatDependencyDeleteParamsSchema,
	flatDependentTaskParamsSchema,
} from "./dependency.schema";
import {
	createDependency,
	createDependencyForTask,
	listDependencies,
	listDependenciesForTask,
	removeDependency,
	removeDependencyForTask,
} from "./dependency.service";

type DependencyRoutesVariables = RequestIdVariables & AuthVariables;

export const dependencyRoutes = new Hono<{
	Variables: DependencyRoutesVariables;
}>();

dependencyRoutes.use("*", authRequired);

dependencyRoutes.use(
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

dependencyRoutes.get("/:projectId/tasks/:taskId/dependencies", async (c) => {
	const { projectId, taskId } = dependentTaskParamsSchema.parse(c.req.param());
	const dependencies = await listDependencies(c.get("user"), projectId, taskId);
	return c.json(successResponse({ dependencies }));
});

dependencyRoutes.post("/:projectId/tasks/:taskId/dependencies", async (c) => {
	const { projectId, taskId } = dependentTaskParamsSchema.parse(c.req.param());
	const dependency = await createDependency(
		c.get("user"),
		projectId,
		taskId,
		await readJson(c),
	);
	return c.json(successResponse({ dependency }), 201);
});

dependencyRoutes.delete(
	"/:projectId/tasks/:taskId/dependencies/:dependencyTaskId",
	async (c) => {
		const { projectId, taskId, dependencyTaskId } =
			dependencyDeleteParamsSchema.parse(c.req.param());
		await removeDependency(c.get("user"), projectId, taskId, dependencyTaskId);
		return c.body(null, 204);
	},
);

/**
 * Flat dependency surface mounted at `/tasks`.
 *
 * The project scoped routes above stay for project work. These exist so a task
 * can manage its own prerequisites from anywhere in the app while reusing the
 * exact same service, policy and ABAC checks, which keeps the two surfaces
 * impossible to drift apart.
 */
export const flatDependencyRoutes = new Hono<{
	Variables: DependencyRoutesVariables;
}>();

flatDependencyRoutes.use("*", authRequired);

flatDependencyRoutes.use(
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

flatDependencyRoutes.get("/:taskId/dependencies", async (c) => {
	const { taskId } = flatDependentTaskParamsSchema.parse(c.req.param());
	const dependencies = await listDependenciesForTask(c.get("user"), taskId);
	return c.json(successResponse({ dependencies }));
});

flatDependencyRoutes.post("/:taskId/dependencies", async (c) => {
	const { taskId } = flatDependentTaskParamsSchema.parse(c.req.param());
	const dependency = await createDependencyForTask(
		c.get("user"),
		taskId,
		await readJson(c),
	);
	return c.json(successResponse({ dependency }), 201);
});

flatDependencyRoutes.delete(
	"/:taskId/dependencies/:dependencyId",
	async (c) => {
		const { taskId, dependencyId } = flatDependencyDeleteParamsSchema.parse(
			c.req.param(),
		);
		await removeDependencyForTask(c.get("user"), taskId, dependencyId);
		return c.body(null, 204);
	},
);
