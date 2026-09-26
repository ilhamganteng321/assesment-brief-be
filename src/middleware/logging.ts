import { createMiddleware } from "hono/factory";

export const requestLogger = createMiddleware<{
	Variables: { requestId: string };
}>(async (c, next) => {
	const startedAt = performance.now();
	const requestId = c.get("requestId");

	await next();

	const durationMs = Math.round((performance.now() - startedAt) * 100) / 100;
	console.log(
		`[request] id=${requestId} ${c.req.method} ${c.req.path} ${c.res.status} ${durationMs}ms`,
	);
});
