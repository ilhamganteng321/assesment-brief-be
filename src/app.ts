import { Hono } from "hono";
import { methodNotAllowed } from "hono/method-not-allowed";
import { errorResponse } from "./lib/response";
import { corsMiddleware } from "./middleware/cors";
import { errorHandler } from "./middleware/error-handler";
import { requestLogger } from "./middleware/logging";
import { notFoundHandler } from "./middleware/not-found";
import { generalRateLimit } from "./middleware/rate-limit";
import { type RequestIdVariables, requestId } from "./middleware/request-id";
import { securityHeaders } from "./middleware/security";
import { routes } from "./routes/index";

export type AppVariables = RequestIdVariables;

export const app = new Hono<{ Variables: AppVariables }>();

app.use("*", requestId);
app.use("*", requestLogger);
app.use("*", securityHeaders);
app.use("*", corsMiddleware);
app.use("*", generalRateLimit);
app.use(
	"*",
	methodNotAllowed({
		app,
		onMethodNotAllowed: (c, methods) =>
			c.json(
				errorResponse(
					"METHOD_NOT_ALLOWED",
					"Method Not Allowed",
					c.get("requestId"),
				),
				405,
				{ Allow: methods.join(", ") },
			),
	}),
);
app.onError(errorHandler);
app.notFound(notFoundHandler);
app.route("/", routes);
