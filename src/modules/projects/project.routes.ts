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
	addProjectMemberSchema,
	projectActivityQuerySchema,
	projectIdParamsSchema,
	projectListQuerySchema,
	projectMemberCandidatesQuerySchema,
	projectMemberParamsSchema,
} from "./project.schema";
import {
	addProjectMember,
	createProject,
	deleteProject,
	getProjectActivity,
	getProjectById,
	getProjectMembers,
	getProjectMetrics,
	listProjects,
	removeProjectMember,
	searchProjectMemberCandidates,
	updateProject,
	updateProjectStatus,
} from "./project.service";

type ProjectRoutesVariables = RequestIdVariables & AuthVariables;

export const projectRoutes = new Hono<{
	Variables: ProjectRoutesVariables;
}>();

projectRoutes.use("*", authRequired);

projectRoutes.use(
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

projectRoutes.get("/", async (c) => {
	const query = projectListQuerySchema.parse(c.req.query());
	const result = await listProjects(c.get("user"), query);
	return c.json(successResponse(result));
});

projectRoutes.post("/", async (c) => {
	const project = await createProject(c.get("user"), await readJson(c));
	return c.json(successResponse({ project }), 201);
});

projectRoutes.get("/:projectId", async (c) => {
	const { projectId } = projectIdParamsSchema.parse(c.req.param());
	const project = await getProjectById(c.get("user"), projectId);
	return c.json(successResponse({ project }));
});

projectRoutes.patch("/:projectId", async (c) => {
	const { projectId } = projectIdParamsSchema.parse(c.req.param());
	const project = await updateProject(
		c.get("user"),
		projectId,
		await readJson(c),
	);
	return c.json(successResponse({ project }));
});

/**
 * The lifecycle route.
 *
 * Separate from the general update so a status change is a single, named intent:
 * the body carries one field, and the transition itself is checked against the
 * project lifecycle rather than trusted because the caller already has edit
 * rights. The general update route applies the same rule to a status it carries,
 * so the two cannot disagree.
 */
projectRoutes.patch("/:projectId/status", async (c) => {
	const { projectId } = projectIdParamsSchema.parse(c.req.param());
	const project = await updateProjectStatus(
		c.get("user"),
		projectId,
		await readJson(c),
	);
	return c.json(successResponse({ project }));
});

projectRoutes.delete("/:projectId", async (c) => {
	const { projectId } = projectIdParamsSchema.parse(c.req.param());
	await deleteProject(c.get("user"), projectId);
	return c.body(null, 204);
});

projectRoutes.get("/:projectId/metrics", async (c) => {
	const { projectId } = projectIdParamsSchema.parse(c.req.param());
	const metrics = await getProjectMetrics(c.get("user"), projectId);
	return c.json(successResponse({ metrics }));
});

projectRoutes.get("/:projectId/activity", async (c) => {
	const { projectId } = projectIdParamsSchema.parse(c.req.param());
	const query = projectActivityQuerySchema.parse(c.req.query());
	const activity = await getProjectActivity(c.get("user"), projectId, query);
	return c.json(successResponse(activity));
});

projectRoutes.get("/:projectId/members", async (c) => {
	const { projectId } = projectIdParamsSchema.parse(c.req.param());
	const members = await getProjectMembers(c.get("user"), projectId);
	return c.json(successResponse({ members }));
});

/**
 * Candidate search for the "add member" flow.
 *
 * Registered before the member routes it would otherwise shadow, and scoped to
 * the project it is nested under: this is a search for people to put on *this*
 * project, not a general user directory. The service refuses anyone who could
 * not act on the answer.
 */
projectRoutes.get("/:projectId/members/candidates", async (c) => {
	const { projectId } = projectIdParamsSchema.parse(c.req.param());
	const query = projectMemberCandidatesQuerySchema.parse(c.req.query());
	const candidates = await searchProjectMemberCandidates(
		c.get("user"),
		projectId,
		query,
	);
	return c.json(successResponse(candidates));
});

projectRoutes.post("/:projectId/members", async (c) => {
	const { projectId } = projectIdParamsSchema.parse(c.req.param());
	const { userId } = addProjectMemberSchema.parse(await readJson(c));
	const member = await addProjectMember(c.get("user"), projectId, userId);
	return c.json(successResponse({ member }), 201);
});

projectRoutes.delete("/:projectId/members/:userId", async (c) => {
	const { projectId, userId } = projectMemberParamsSchema.parse(c.req.param());
	await removeProjectMember(c.get("user"), projectId, userId);
	return c.body(null, 204);
});
