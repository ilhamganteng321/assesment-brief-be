import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { JSON_BODY_LIMIT_BYTES } from "../../config/limits";
import { errorResponse, successResponse } from "../../lib/response";
import type { AuthVariables } from "../../middleware/auth";
import { authRequired } from "../../middleware/auth";
import type { RequestIdVariables } from "../../middleware/request-id";
import { userIdParamsSchema, userListQuerySchema } from "./user.schema";
import { getUserById, listUsers } from "./user.service";

type UserRoutesVariables = RequestIdVariables & AuthVariables;

export const userRoutes = new Hono<{ Variables: UserRoutesVariables }>();

// Every route here is authenticated. The directory has no public surface: a
// person's name, address and department are not public in this product, and the
// only question is which signed-in roles may read them.
userRoutes.use("*", authRequired);

userRoutes.use(
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

userRoutes.get("/", async (c) => {
	const query = userListQuerySchema.parse(c.req.query());
	const result = await listUsers(c.get("user"), query);
	return c.json(successResponse(result));
});

userRoutes.get("/:userId", async (c) => {
	const { userId } = userIdParamsSchema.parse(c.req.param());
	const user = await getUserById(c.get("user"), userId);
	return c.json(successResponse({ user }));
});
