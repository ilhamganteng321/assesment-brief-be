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
	invitationParamsSchema,
	invitationTokenParamsSchema,
	projectIdParamsSchema,
} from "./invitation.schema";
import {
	acceptInvitation,
	cancelProjectInvitation,
	createProjectInvitation,
	getInvitationPreview,
	listProjectInvitations,
	resendProjectInvitation,
} from "./invitation.service";

type InvitationRoutesVariables = RequestIdVariables & AuthVariables;

export const projectInvitationRoutes = new Hono<{
	Variables: InvitationRoutesVariables;
}>();

/**
 * The project-scoped half of the feature, mounted under `/projects`.
 *
 * Separate from `projectRoutes` rather than added to it, so the invitation
 * surface has its own file and its own mount point. The path prefix is
 * `/projects/:projectId/invitations`, and every route here is PM-only; the service
 * enforces that, and the middleware below is only the transport-level guard that
 * the module is internal-API only.
 */
projectInvitationRoutes.use("*", authRequired);

projectInvitationRoutes.use(
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

projectInvitationRoutes.get("/:projectId/invitations", async (c) => {
	const { projectId } = projectIdParamsSchema.parse(c.req.param());
	const invitations = await listProjectInvitations(c.get("user"), projectId);
	return c.json(successResponse({ invitations }));
});

projectInvitationRoutes.post("/:projectId/invitations", async (c) => {
	const { projectId } = projectIdParamsSchema.parse(c.req.param());
	const invitation = await createProjectInvitation(
		c.get("user"),
		projectId,
		await readJson(c),
	);
	return c.json(successResponse({ invitation }), 201);
});

/**
 * Reissues the token on an existing invitation.
 *
 * A POST rather than a PATCH, because the token is rotated: the previous
 * credential stops working as a side effect, and that is not an edit to the
 * invitation's visible fields. Returning the invitation rather than a 204 lets
 * the caller see the extended expiry without refetching the list.
 */
projectInvitationRoutes.post(
	"/:projectId/invitations/:invitationId/resend",
	async (c) => {
		const { projectId, invitationId } = invitationParamsSchema.parse(
			c.req.param(),
		);
		const invitation = await resendProjectInvitation(
			c.get("user"),
			projectId,
			invitationId,
		);
		return c.json(successResponse({ invitation }));
	},
);

projectInvitationRoutes.delete(
	"/:projectId/invitations/:invitationId",
	async (c) => {
		const { projectId, invitationId } = invitationParamsSchema.parse(
			c.req.param(),
		);
		await cancelProjectInvitation(c.get("user"), projectId, invitationId);
		return c.body(null, 204);
	},
);

/**
 * The recipient-facing half, mounted at the root.
 *
 * Not under `/projects`, because the caller has no project id: the token is the
 * only thing they were given, and requiring them to also know which project the
 * link belongs to would be asking for information the email already contains.
 * The preview route is separated from the accept route so the acceptance screen
 * can render "who invited you, and does this still work" before offering a
 * button, which is also the only way to show a recipient why they are being
 * turned away without making them press it first.
 */
export const flatInvitationRoutes = new Hono<{
	Variables: InvitationRoutesVariables;
}>();

/**
 * Scoped to `/invitations/*` rather than `*`, and this router is mounted at the
 * root — so a blanket middleware here would run for *every* request that reaches
 * it. That includes `/docs`, `/openapi.json` and any unknown path, which would
 * turn the API reference into a 401 and replace the application's own 404 and 405
 * handling with an authentication error. Naming the prefix keeps the guard on the
 * routes it is for and leaves every other path alone.
 */
flatInvitationRoutes.use("/invitations/*", authRequired);

flatInvitationRoutes.get("/invitations/:token", async (c) => {
	const params = invitationTokenParamsSchema.parse(c.req.param());
	const invitation = await getInvitationPreview(c.get("user"), params);
	return c.json(successResponse({ invitation }));
});

/**
 * A POST that changes nothing but the caller's own access.
 *
 * Not a GET, even though the effect reads like a query: it creates a
 * `ProjectMembers` row, and a link-scanner or a browser prefetch that followed a
 * GET here would join people to projects on their behalf. The token arrives in
 * the path, which is fine — it is a secret the holder already has, and putting it
 * in the path is what lets the request be a plain POST with no body and no
 * token echoed into a query string that gets logged.
 */
flatInvitationRoutes.post("/invitations/:token/accept", async (c) => {
	const params = invitationTokenParamsSchema.parse(c.req.param());
	const accepted = await acceptInvitation(c.get("user"), params);
	return c.json(successResponse(accepted));
});
