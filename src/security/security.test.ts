import { describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import type { Varchar } from "@prisma/orm-postgres/target/codec-types";
import { blindCast } from "@prisma/orm-postgres/utils/casts";
import { Hono } from "hono";
import jwt from "jsonwebtoken";
import { app } from "../app";
import { env } from "../config/env";
import { HttpError } from "../lib/http-error";
import type { AuthVariables } from "../middleware/auth";
import { errorHandler } from "../middleware/error-handler";
import {
	buildAuthRateLimitKey,
	clientIp,
	createRateLimitMiddleware,
	MemoryRateLimitStore,
	normalizeEmail,
} from "../middleware/rate-limit";
import type { RequestIdVariables } from "../middleware/request-id";
import { requestId } from "../middleware/request-id";
import {
	attachmentListQuerySchema,
	detectAttachmentMimeType,
	sanitizeAttachmentFileName,
} from "../modules/attachments/attachment.schema";
import { LocalStorageProvider } from "../modules/attachments/storage/local.storage";
import { auditRoutes } from "../modules/audit/audit.routes";
import { auditListQuerySchema } from "../modules/audit/audit.schema";
import { verifyAccessToken } from "../modules/auth/auth.service";
import type { SafeUser } from "../modules/auth/auth.types";
import { requirePermission } from "../modules/authorization/authorization.middleware";
import { authorizationService } from "../modules/authorization/authorization.service";
import type {
	ProjectAuthorizationContext,
	TaskAuthorizationContext,
	UserContext,
} from "../modules/authorization/authorization.types";
import { Permission } from "../modules/authorization/authorization.types";
import {
	canAccessClientApi,
	canViewClientAuditLogs,
	canViewClientTask,
} from "../modules/client/client.policy";
import { clientTaskListQuerySchema } from "../modules/client/client.schema";
import { toClientTask } from "../modules/client/client.service";
import type { ClientTaskRecord } from "../modules/client/client.types";
import {
	CircularDependencyError,
	CrossProjectDependencyError,
	DependencyAccessDeniedError,
	DependencyAlreadyExistsError,
	SelfDependencyError,
	TaskBlockedError,
} from "../modules/dependencies/dependency.errors";
import { canReachTask } from "../modules/dependencies/dependency.service";
import {
	createTaskSchema,
	projectIdParamSchema,
	taskDeleteQuerySchema,
	taskIdParamSchema,
	taskListQuerySchema,
	updateTaskSchema,
} from "../modules/tasks/task.schema";

const VARCHAR = "static security test fixture";

function varchar<N extends number>(value: string): Varchar<N> {
	return blindCast<Varchar<N>, typeof VARCHAR>(value);
}

function toSafeUser(user: UserContext): SafeUser {
	return {
		...user,
		name: varchar<100>("Test User"),
		email: varchar<255>(`${user.id}@nodewave.test`),
	};
}

const pm: UserContext = { id: "pm-1", role: "PM", department: "PRODUCT" };
const internal: UserContext = {
	id: "fe-1",
	role: "INTERNAL",
	department: "FRONTEND",
};
const client: UserContext = {
	id: "cl-1",
	role: "CLIENT",
	department: "CLIENT",
};

function project(memberIds: readonly string[]): ProjectAuthorizationContext {
	return {
		id: "proj-1",
		status: "ACTIVE",
		memberships: memberIds.map((userId) => ({ userId })),
	};
}

function task(
	overrides: Partial<TaskAuthorizationContext> = {},
): TaskAuthorizationContext {
	return {
		id: "task-1",
		projectId: "proj-1",
		status: "IN_PROGRESS",
		assignedToId: null,
		clientVisible: false,
		...overrides,
	};
}

function appWithUser(user: SafeUser) {
	const h = new Hono<{ Variables: AuthVariables }>();
	h.use("*", async (c, next) => {
		c.set("user", user);
		await next();
	});
	h.onError((err, c) => errorHandler(err, c));
	return h;
}

function miniApp(
	register: (h: Hono<{ Variables: RequestIdVariables }>) => void,
) {
	const h = new Hono<{ Variables: RequestIdVariables }>();
	h.use("*", requestId);
	h.onError((err, c) => errorHandler(err, c));
	register(h);
	return h;
}

const UUID_RE =
	/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type ErrorBody = {
	error: { code: string; message: string; requestId: string };
};

function expectUnauthorized(body: ErrorBody): void {
	expect(body.error.code).toBe("UNAUTHORIZED");
	expect(body.error.message).toBe("Invalid or expired access token");
	expect(body.error.requestId).toBeDefined();
}

describe("security: JWT validation", () => {
	test("rejects a malformed access token with 401", async () => {
		const res = await app.request("/auth/me", {
			headers: { Authorization: "Bearer not-a-jwt" },
		});
		expect(res.status).toBe(401);
		expectUnauthorized((await res.json()) as ErrorBody);
	});

	test("rejects an expired access token with 401", async () => {
		const token = jwt.sign(
			{ sub: "user-1", exp: Math.floor(Date.now() / 1000) - 60 },
			env.JWT_SECRET,
			{ algorithm: "HS256" },
		);
		const res = await app.request("/auth/me", {
			headers: { Authorization: `Bearer ${token}` },
		});
		expect(res.status).toBe(401);
		expectUnauthorized((await res.json()) as ErrorBody);
	});

	test("rejects tokens signed with a non-whitelisted algorithm", () => {
		const token = jwt.sign({ sub: "user-1" }, env.JWT_SECRET, {
			algorithm: "HS512",
			expiresIn: "1h",
		});
		expect(() => verifyAccessToken(token)).toThrow(
			new HttpError(401, "UNAUTHORIZED", "Invalid or expired access token"),
		);
	});

	test("accepts an HS256 token signed with the configured secret", () => {
		const token = jwt.sign({ sub: "user-1" }, env.JWT_SECRET, {
			algorithm: "HS256",
			expiresIn: "1h",
		});
		expect(verifyAccessToken(token)).toBe("user-1");
	});
});

describe("security: request ID handling", () => {
	test("echoes a well-formed client-supplied request id", async () => {
		const id = "3c9a1e8a-6d5b-4f21-9c3f-8f0d1a2b3c4d";
		const res = await app.request("/health", {
			headers: { "x-request-id": id },
		});
		expect(res.headers.get("x-request-id")).toBe(id);
	});

	test("ignores a malformed client-supplied request id and generates a UUID", async () => {
		const res = await app.request("/health", {
			headers: { "x-request-id": "../../etc/passwd" },
		});
		const echoed = res.headers.get("x-request-id");
		expect(UUID_RE.test(echoed ?? "")).toBe(true);
		expect(echoed).not.toBe("../../etc/passwd");
	});
});

describe("security: security headers and CORS", () => {
	test("sets security headers on every response", async () => {
		const res = await app.request("/health");
		expect(res.headers.get("X-Content-Type-Options")).toBe("nosniff");
		expect(res.headers.get("X-Frame-Options")).toBe("DENY");
		expect(res.headers.get("Referrer-Policy")).toBe("no-referrer");
		expect(res.headers.get("Content-Security-Policy")).toContain(
			"default-src 'none'",
		);
		expect(res.headers.get("Content-Security-Policy")).toContain(
			"frame-ancestors 'none'",
		);
		expect(res.status).toBe(200);
	});

	test("CORS allows a configured frontend origin", async () => {
		const res = await app.request("/health", {
			headers: { Origin: "http://localhost:3001" },
		});
		expect(res.headers.get("access-control-allow-origin")).toBe(
			"http://localhost:3001",
		);
	});

	test("CORS does not allow foreign origins", async () => {
		const res = await app.request("/health", {
			headers: { Origin: "http://evil.example" },
		});
		expect(res.headers.get("access-control-allow-origin")).toBeNull();
	});
});

describe("security: rate limiting", () => {
	test("rejects requests beyond the configured limit with 429 and headers", async () => {
		const h = miniApp((sub) => {
			sub.use(
				"*",
				createRateLimitMiddleware({
					max: 3,
					windowSeconds: 60,
					store: new MemoryRateLimitStore(),
					keyFactory: () => "test-key",
				}),
			);
			sub.get("/", (c) => c.json({ ok: true }));
		});

		const statuses: number[] = [];
		for (let index = 0; index < 4; index++) {
			statuses.push((await h.request("/")).status);
		}
		expect(statuses).toEqual([200, 200, 200, 429]);

		const rejected = await h.request("/");
		expect(rejected.status).toBe(429);
		expect(rejected.headers.get("RateLimit-Limit")).toBe("3");
		expect(rejected.headers.get("RateLimit-Remaining")).toBe("0");
		expect(
			Number.parseInt(rejected.headers.get("Retry-After") ?? "0", 10),
		).toBeGreaterThan(0);
		const body = (await rejected.json()) as { error: { code: string } };
		expect(body.error.code).toBe("RATE_LIMITED");
	});

	test("auth key embeds the normalized email", () => {
		expect(normalizeEmail("  User@Example.COM ")).toBe("user@example.com");
		expect(
			buildAuthRateLimitKey({
				method: "POST",
				path: "/auth/login",
				ip: "1.2.3.4",
				email: " User@Example.COM ",
			}),
		).toBe("auth:POST:/auth/login:1.2.3.4:user@example.com");
		expect(
			buildAuthRateLimitKey({
				method: "POST",
				path: "/auth/login",
				ip: "1.2.3.4",
				email: undefined,
			}),
		).toBe("auth:POST:/auth/login:1.2.3.4:*");
	});

	test("clientIp prefers x-forwarded-for then x-real-ip, falling back to unknown", async () => {
		const h = miniApp((sub) => {
			sub.get("/", (c) => c.json({ ip: clientIp(c) }));
		});
		const forwarded = await h.request("/", {
			headers: { "x-forwarded-for": "203.0.113.5, 10.0.0.2" },
		});
		expect(((await forwarded.json()) as { ip: string }).ip).toBe("203.0.113.5");

		const realIp = await h.request("/", {
			headers: { "x-real-ip": "198.51.100.7" },
		});
		expect(((await realIp.json()) as { ip: string }).ip).toBe("198.51.100.7");

		const none = await h.request("/");
		expect(((await none.json()) as { ip: string }).ip).toBe("unknown");
	});
});

describe("security: request size limits", () => {
	test("rejects an oversized auth body with 413", async () => {
		const oversized = JSON.stringify({
			email: "a@b.co",
			password: "password",
			name: "User",
			padding: "x".repeat(20 * 1024),
		});
		const res = await app.request("/auth/register", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: oversized,
		});
		expect(res.status).toBe(413);
		const body = (await res.json()) as { error: { code: string } };
		expect(body.error.code).toBe("PAYLOAD_TOO_LARGE");
	});

	test("lets an in-limit body through to validation", async () => {
		const res = await app.request("/auth/register", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({}),
		});
		expect(res.status).toBe(400);
		const body = (await res.json()) as { error: { code: string } };
		expect(body.error.code).toBe("INVALID_REQUEST");
	});
});

describe("security: strict validation and mass assignment", () => {
	test("rejects disabled query parameters (sort/filter/includeDeleted)", () => {
		expect(() => taskListQuerySchema.parse({ sortBy: "createdAt" })).toThrow();
		expect(() => taskListQuerySchema.parse({ filter: "{}" })).toThrow();
		expect(() =>
			taskListQuerySchema.parse({ includeDeleted: "true" }),
		).toThrow();
		expect(() => clientTaskListQuerySchema.parse({ filter: "{}" })).toThrow();
		expect(() => clientTaskListQuerySchema.parse({ order: "desc" })).toThrow();
		expect(() => auditListQuerySchema.parse({ sortBy: "changedAt" })).toThrow();
		expect(() => attachmentListQuerySchema.parse({ order: "asc" })).toThrow();
		expect(() =>
			taskDeleteQuerySchema.parse({ version: "1", force: "true" }),
		).toThrow();
	});

	test("rejects excessive pagination", () => {
		expect(() => taskListQuerySchema.parse({ limit: "1000000" })).toThrow();
		expect(() =>
			clientTaskListQuerySchema.parse({ limit: "1000000" }),
		).toThrow();
		expect(() => auditListQuerySchema.parse({ limit: "1000000" })).toThrow();
		expect(() =>
			attachmentListQuerySchema.parse({ limit: "1000000" }),
		).toThrow();
	});

	test("update and create schemas reject server-controlled fields", () => {
		expect(() => updateTaskSchema.parse({ role: "PM", version: 1 })).toThrow();
		expect(() =>
			updateTaskSchema.parse({
				projectId: "3c9a1e8a-6d5b-4f21-9c3f-8f0d1a2b3c4d",
				version: 1,
			}),
		).toThrow();
		expect(() =>
			updateTaskSchema.parse({ deletedAt: null, version: 1 }),
		).toThrow();
		expect(() =>
			updateTaskSchema.parse({ state: { x: 1 }, version: 1 }),
		).toThrow();
		expect(() =>
			createTaskSchema.parse({ title: "X", id: "task-1" }),
		).toThrow();
	});

	test("invalid uuid path parameters return 400", async () => {
		const h = miniApp((sub) => {
			sub.get("/:projectId", (c) => {
				projectIdParamSchema.parse(c.req.param());
				return c.json({ ok: true });
			});
			sub.get("/:projectId/tasks/:taskId", (c) => {
				taskIdParamSchema.parse(c.req.param());
				return c.json({ ok: true });
			});
		});

		const invalidProject = await h.request("/not-a-uuid");
		expect(invalidProject.status).toBe(400);
		expect(
			((await invalidProject.json()) as { error: { code: string } }).error.code,
		).toBe("INVALID_REQUEST");

		const validProject = await h.request(
			"/3c9a1e8a-6d5b-4f21-9c3f-8f0d1a2b3c4d",
		);
		expect(validProject.status).toBe(200);

		const invalidTask = await h.request(
			"/3c9a1e8a-6d5b-4f21-9c3f-8f0d1a2b3c4d/tasks/nope",
		);
		expect(invalidTask.status).toBe(400);
	});
});

describe("security: authorization and data isolation", () => {
	test("users cannot access projects they do not belong to", () => {
		expect(
			authorizationService.canAccessProject({
				user: client,
				project: project(["someone-else"]),
			}),
		).toBe(false);
		expect(
			authorizationService.canViewTask({
				user: internal,
				task: task({ assignedToId: null }),
				project: project([]),
			}),
		).toBe(false);
	});

	test("clients cannot read audit logs or edit task descriptions", () => {
		expect(canAccessClientApi(client)).toBe(true);
		expect(canViewClientAuditLogs(client)).toBe(false);
		expect(
			authorizationService.hasPermission(client, Permission.AUDIT_READ),
		).toBe(false);
		expect(
			authorizationService.canEditTaskDescription({ user: internal }),
		).toBe(false);
		expect(authorizationService.canEditTaskDescription({ user: pm })).toBe(
			true,
		);
	});

	test("client DTO never leaks server-controlled or internal fields", () => {
		const record = blindCast<ClientTaskRecord, typeof VARCHAR>({
			id: "task-1",
			title: "Dashboard",
			description: "secret",
			status: "IN_PROGRESS",
			clientVisible: true,
			version: 9,
			assignedToId: "fe-1",
			costEstimateCents: 100000,
		});
		const dto = toClientTask(record);
		expect(Object.keys(dto).sort()).toEqual([
			"clientVisible",
			"description",
			"id",
			"status",
			"title",
		]);
		expect(dto).not.toHaveProperty("version");
		expect(dto).not.toHaveProperty("assignedToId");
		expect(dto).not.toHaveProperty("costEstimateCents");

		expect(
			canViewClientTask({
				user: client,
				task: task({ clientVisible: false }),
				project: project(["cl-1"]),
			}),
		).toBe(false);
	});

	test("audit routes expose only read endpoints", () => {
		const methods = new Set(auditRoutes.routes.map((route) => route.method));
		expect(methods.has("GET")).toBe(true);
		for (const method of methods) {
			expect(["ALL", "GET"].includes(method)).toBe(true);
		}
	});

	test("role mismatch for a guarded permission returns 403", async () => {
		const h = appWithUser(toSafeUser(internal));
		h.get(
			"/project-create",
			requirePermission(Permission.PROJECT_CREATE),
			(c) => c.json({ ok: true }),
		);
		const res = await h.request("/project-create", {
			headers: { Authorization: "fixed-for-the-app-under-test" },
		});
		expect(res.status).toBe(403);
		const body = (await res.json()) as { error: { code: string } };
		expect(body.error.code).toBe("FORBIDDEN");

		const granted = appWithUser(toSafeUser(pm));
		granted.get(
			"/project-create",
			requirePermission(Permission.PROJECT_CREATE),
			(c) => c.json({ ok: true }),
		);
		const allowed = await granted.request("/project-create");
		expect(allowed.status).toBe(200);
	});
});

describe("security: attachment upload hardening", () => {
	test("detects executable or mismatched content and rejects it", () => {
		const textEncoder = new TextEncoder();
		expect(
			detectAttachmentMimeType(textEncoder.encode("#!/bin/sh"), "image/png"),
		).toBeNull();
		expect(
			detectAttachmentMimeType(new Uint8Array([0x4d, 0x5a]), "image/png"),
		).toBeNull();
		const png = new Uint8Array([
			0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
		]);
		expect(detectAttachmentMimeType(png, "image/png")).toBe("image/png");
		expect(detectAttachmentMimeType(png, "application/pdf")).toBeNull();
		expect(detectAttachmentMimeType(new Uint8Array(), "image/png")).toBeNull();
	});

	test("sanitizes dangerous attachment file names", () => {
		expect(sanitizeAttachmentFileName("../../etc/passwd")).toBe("passwd");
		expect(sanitizeAttachmentFileName("..\\..\\evil.sh")).toBe("evil.sh");
		expect(sanitizeAttachmentFileName("report.pdf")).toBe("report.pdf");
		expect(sanitizeAttachmentFileName("a\u0000b.pdf")).toBe("ab.pdf");
		expect(sanitizeAttachmentFileName('report"\r\n;=.pdf')).toBe("report.pdf");
		expect(sanitizeAttachmentFileName("...")).toBeNull();
		expect(sanitizeAttachmentFileName("   ")).toBeNull();
	});

	test("local storage rejects path traversal keys", async () => {
		const storeRoot = resolve(tmpdir(), `opencode-security-${randomUUID()}`);
		const provider = new LocalStorageProvider(storeRoot);
		try {
			await expect(
				provider.upload({
					key: "../escape.txt",
					bytes: new TextEncoder().encode("x"),
				}),
			).rejects.toThrow("Invalid storage key");
			await expect(
				provider.upload({
					key: "sub/../../up.txt",
					bytes: new TextEncoder().encode("x"),
				}),
			).rejects.toThrow("Invalid storage key");
			await expect(
				provider.upload({
					key: "/absolute.txt",
					bytes: new TextEncoder().encode("x"),
				}),
			).rejects.toThrow("Invalid storage key");
			await expect(
				provider.upload({
					key: "C:/windows.txt",
					bytes: new TextEncoder().encode("x"),
				}),
			).rejects.toThrow("Invalid storage key");

			await provider.upload({
				key: "files/report.pdf",
				bytes: new TextEncoder().encode("pdf"),
			});
			const stored = await provider.get("files/report.pdf");
			expect(stored).not.toBeNull();
		} finally {
			await rm(storeRoot, { recursive: true, force: true });
		}
	});
});

describe("security: dependency cycles and error mapping", () => {
	test("detects transitive dependency cycles without touching the database", () => {
		const edges = [
			{ dependentTaskId: "A", dependencyTaskId: "B" },
			{ dependentTaskId: "B", dependencyTaskId: "C" },
			{ dependentTaskId: "C", dependencyTaskId: "A" },
		];
		expect(canReachTask(edges, "A", "C")).toBe(true);
		expect(canReachTask(edges, "A", "A")).toBe(true);
		expect(canReachTask(edges, "B", "Z")).toBe(false);
		expect(
			canReachTask(
				[
					{ dependentTaskId: "X", dependencyTaskId: "Y" },
					{ dependentTaskId: "Y", dependencyTaskId: "Z" },
				],
				"X",
				"Z",
			),
		).toBe(true);
	});

	test("dependency violations map to stable HTTP statuses", () => {
		expect(new SelfDependencyError()).toMatchObject({
			status: 400,
			code: "SELF_DEPENDENCY",
		});
		expect(new CrossProjectDependencyError()).toMatchObject({
			status: 400,
			code: "CROSS_PROJECT_DEPENDENCY",
		});
		expect(new DependencyAccessDeniedError()).toMatchObject({
			status: 403,
			code: "DEPENDENCY_ACCESS_DENIED",
		});
		expect(new DependencyAlreadyExistsError()).toMatchObject({
			status: 409,
			code: "DEPENDENCY_ALREADY_EXISTS",
		});
		expect(new CircularDependencyError()).toMatchObject({
			status: 409,
			code: "CIRCULAR_DEPENDENCY",
		});
		expect(new TaskBlockedError([])).toMatchObject({
			status: 409,
			code: "TASK_BLOCKED",
		});
	});
});

describe("security: HTTP semantics for undefined routes", () => {
	test("unknown paths return 404 NOT_FOUND with a request id", async () => {
		const res = await app.request("/definitely-not-a-route");
		expect(res.status).toBe(404);
		const body = (await res.json()) as {
			error: { code: string; requestId: string };
		};
		expect(body.error.code).toBe("NOT_FOUND");
		expect(body.error.requestId).toBeDefined();
	});

	test("known paths reject unsupported methods with 405 and Allow", async () => {
		const res = await app.request("/auth/register", { method: "PUT" });
		expect(res.status).toBe(405);
		const body = (await res.json()) as { error: { code: string } };
		expect(body.error.code).toBe("METHOD_NOT_ALLOWED");
		expect(res.headers.get("Allow")).toContain("POST");
	});
});
