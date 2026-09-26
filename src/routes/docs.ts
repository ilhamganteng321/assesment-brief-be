import { Scalar } from "@scalar/hono-api-reference";
import { Hono } from "hono";
import { createMiddleware } from "hono/factory";
import { API_TITLE, API_VERSION, openApiDocument } from "../docs/openapi";

export const docsRoutes = new Hono();

// Scalar renders the reference UI from an inline <style> theme and an inline
// module <script> that imports the bundle from jsDelivr, so the global strict
// CSP (default-src 'none') would block it. Relax the policy for /docs only.
const docsContentSecurityPolicy = [
	"default-src 'self'",
	"script-src 'self' 'unsafe-inline' https://*.jsdelivr.net",
	"style-src 'self' 'unsafe-inline'",
	"img-src 'self' data: https://*.jsdelivr.net",
	"font-src 'self' data: https://*.jsdelivr.net",
	"connect-src 'self' https://*.jsdelivr.net",
	"base-uri 'none'",
	"form-action 'self'",
	"frame-ancestors 'none'",
].join("; ");

docsRoutes.use(
	"/docs",
	createMiddleware(async (c, next) => {
		c.header("Content-Security-Policy", docsContentSecurityPolicy);
		await next();
	}),
);

docsRoutes.get(
	"/docs",
	Scalar({
		url: "/openapi.json",
		pageTitle: `${API_TITLE} (${API_VERSION})`,
		showSidebar: true,
		darkMode: true,
	}),
);

docsRoutes.get("/openapi.json", (c) =>
	c.json(openApiDocument, 200, {
		"Content-Type": "application/json",
	}),
);

export const DOCS_INFO_TITLE = API_TITLE;
export const DOCS_INFO_VERSION = API_VERSION;
