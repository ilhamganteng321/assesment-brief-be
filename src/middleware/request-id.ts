import { randomUUID } from "node:crypto";
import { createMiddleware } from "hono/factory";

export type RequestIdVariables = {
	requestId: string;
};

const UUID_RE =
	/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isTrustedRequestId(value: string): boolean {
	return value.length > 0 && value.length <= 128 && UUID_RE.test(value);
}

export const requestId = createMiddleware<{ Variables: RequestIdVariables }>(
	async (c, next) => {
		const incoming = c.req.header("x-request-id");
		const id =
			incoming !== undefined && isTrustedRequestId(incoming)
				? incoming
				: randomUUID();

		c.set("requestId", id);
		c.header("X-Request-ID", id);

		await next();
	},
);
