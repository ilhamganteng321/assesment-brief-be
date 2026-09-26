import { Hono } from "hono";
import { errorResponse } from "../lib/response";
import type { RequestIdVariables } from "../middleware/request-id";
import { db } from "../prisma/db";

export const SERVICE_NAME = "project-management-api";

export const healthRoutes = new Hono<{ Variables: RequestIdVariables }>();

healthRoutes.get("/", (c) => c.json({ status: "ok", service: SERVICE_NAME }));

healthRoutes.get("/live", (c) =>
	c.json({ status: "ok", service: SERVICE_NAME }),
);

healthRoutes.get("/ready", async (c) => {
	try {
		await db.orm.public.Users.aggregate((aggregate) => ({
			total: aggregate.count(),
		}));
	} catch {
		return c.json(
			errorResponse(
				"DATABASE_UNAVAILABLE",
				"Database is unavailable",
				c.get("requestId"),
			),
			503,
		);
	}
	return c.json({ status: "ready", database: "connected" });
});
