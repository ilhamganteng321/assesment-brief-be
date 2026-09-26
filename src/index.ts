import { app } from "./app";
import { env } from "./config/env";

const server = Bun.serve({
	hostname: "0.0.0.0",
	port: env.PORT,
	fetch: app.fetch,
});

console.log(
	`[server] listening on http://0.0.0.0:${server.port} (${env.NODE_ENV})`,
);
