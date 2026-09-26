import { describe, expect, test } from "bun:test";
import type { Varchar } from "@prisma/orm-postgres/target/codec-types";
import { blindCast } from "@prisma/orm-postgres/utils/casts";
import { Hono } from "hono";
import { app } from "../../app";
import type { AuthVariables } from "../../middleware/auth";
import { errorHandler } from "../../middleware/error-handler";
import type { SafeUser } from "../auth/auth.types";
import { requirePermission, requireRole } from "./authorization.middleware";
import { authorizationService } from "./authorization.service";
import type {
	ProjectAuthorizationContext,
	TaskAuthorizationContext,
	UserContext,
} from "./authorization.types";
import { Permission } from "./authorization.types";

const varchar = <N extends number>(value: string): Varchar<N> =>
	blindCast<Varchar<N>, "static test fixture value">(value);

const pm: UserContext = { id: "pm-1", role: "PM", department: "PRODUCT" };
const uiUx: UserContext = { id: "ui-1", role: "INTERNAL", department: "UI_UX" };
const frontend: UserContext = {
	id: "fe-1",
	role: "INTERNAL",
	department: "FRONTEND",
};
const client: UserContext = {
	id: "cl-1",
	role: "CLIENT",
	department: "CLIENT",
};

function toSafeUser(user: UserContext): SafeUser {
	return {
		...user,
		name: varchar<100>("Test User"),
		email: varchar<255>(`${user.id}@nodewave.test`),
	};
}

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
	h.get("/task", requirePermission(Permission.TASK_READ), (c) =>
		c.json({ ok: true }),
	);
	h.post("/task", requirePermission(Permission.TASK_CREATE), (c) =>
		c.json({ ok: true }),
	);
	h.get("/pm-only", requireRole("PM"), (c) => c.json({ ok: true }));
	return h;
}

describe("authorization: RBAC permission matrix", () => {
	test("PM has project read permission", () => {
		expect(
			authorizationService.hasPermission(pm, Permission.PROJECT_READ),
		).toBe(true);
	});

	test("PM has task update permission", () => {
		expect(authorizationService.hasPermission(pm, Permission.TASK_UPDATE)).toBe(
			true,
		);
	});

	test("CLIENT does not have task update permission", () => {
		expect(
			authorizationService.hasPermission(client, Permission.TASK_UPDATE),
		).toBe(false);
	});

	test("CLIENT does not have task dependency management permission", () => {
		expect(
			authorizationService.hasPermission(
				client,
				Permission.TASK_DEPENDENCY_CREATE,
			),
		).toBe(false);
		expect(
			authorizationService.hasPermission(
				client,
				Permission.TASK_DEPENDENCY_DELETE,
			),
		).toBe(false);
		expect(authorizationService.canManageDependencies({ user: client })).toBe(
			false,
		);
	});

	test("PM and INTERNAL have audit read permission, CLIENT does not", () => {
		expect(authorizationService.hasPermission(pm, Permission.AUDIT_READ)).toBe(
			true,
		);
		expect(
			authorizationService.hasPermission(frontend, Permission.AUDIT_READ),
		).toBe(true);
		expect(
			authorizationService.hasPermission(client, Permission.AUDIT_READ),
		).toBe(false);
	});

	test("hasAnyRole is satisfied by any of the given roles", () => {
		expect(authorizationService.hasAnyRole(uiUx, ["PM", "INTERNAL"])).toBe(
			true,
		);
		expect(authorizationService.hasAnyRole(client, ["PM", "INTERNAL"])).toBe(
			false,
		);
	});
});

describe("authorization: PM completion restriction", () => {
	test("PM cannot complete another user's IN_PROGRESS task", () => {
		const othersTask = task({
			status: "IN_PROGRESS",
			assignedToId: "ui-1",
		});
		expect(
			authorizationService.canCompleteTask({ user: pm, task: othersTask }),
		).toBe(false);
		expect(
			authorizationService.canChangeTaskStatus({
				user: pm,
				task: othersTask,
				targetStatus: "DONE",
			}),
		).toBe(false);
	});

	test("PM completes a task assigned to themselves", () => {
		const ownTask = task({ status: "IN_PROGRESS", assignedToId: "pm-1" });
		expect(
			authorizationService.canCompleteTask({ user: pm, task: ownTask }),
		).toBe(true);
	});
});

describe("authorization: ABAC project membership", () => {
	test("INTERNAL user does not automatically gain access to every project", () => {
		expect(
			authorizationService.canAccessProject({
				user: frontend,
				project: project([]),
			}),
		).toBe(false);
	});

	test("INTERNAL user can access a project they belong to", () => {
		expect(
			authorizationService.canAccessProject({
				user: frontend,
				project: project(["fe-1"]),
			}),
		).toBe(true);
	});

	test("INTERNAL UI/UX user can view an assigned project/task context", () => {
		expect(
			authorizationService.canViewTask({
				user: uiUx,
				task: task({ assignedToId: "ui-1" }),
				project: project(["ui-1"]),
			}),
		).toBe(true);
	});

	test("CLIENT can only access their own project", () => {
		expect(
			authorizationService.canAccessProject({
				user: client,
				project: project(["cl-1"]),
			}),
		).toBe(true);
		expect(
			authorizationService.canAccessProject({
				user: client,
				project: project(["other"]),
			}),
		).toBe(false);
	});
});

describe("authorization: ABAC task assignment", () => {
	test("INTERNAL user can edit a task assigned to them", () => {
		expect(
			authorizationService.canEditTask({
				user: uiUx,
				task: task({ assignedToId: "ui-1" }),
				project: project(["ui-1"]),
			}),
		).toBe(true);
	});

	test("INTERNAL user cannot edit a task that is not assigned to them", () => {
		expect(
			authorizationService.canEditTask({
				user: uiUx,
				task: task({ assignedToId: "other" }),
				project: project(["ui-1"]),
			}),
		).toBe(false);
	});

	test("INTERNAL user cannot edit the core task description", () => {
		expect(authorizationService.canEditTaskDescription({ user: uiUx })).toBe(
			false,
		);
		expect(authorizationService.canEditTaskDescription({ user: pm })).toBe(
			true,
		);
	});

	test("CLIENT can never edit a task", () => {
		expect(
			authorizationService.canEditTask({
				user: client,
				task: task({ assignedToId: "cl-1" }),
				project: project(["cl-1"]),
			}),
		).toBe(false);
	});
});

describe("authorization: client visibility", () => {
	test("CLIENT can read a client-visible task context", () => {
		expect(
			authorizationService.canViewTask({
				user: client,
				task: task({ clientVisible: true }),
				project: project(["cl-1"]),
			}),
		).toBe(true);
	});

	test("CLIENT cannot read a non-client-visible task", () => {
		expect(
			authorizationService.canViewTask({
				user: client,
				task: task({ clientVisible: false }),
				project: project(["cl-1"]),
			}),
		).toBe(false);
	});
});

describe("authorization: HTTP semantics", () => {
	test("unauthenticated request returns 401", async () => {
		const res = await app.request("/auth/me");
		expect(res.status).toBe(401);
		const body = (await res.json()) as {
			error: { code: string; message: string; requestId: string };
		};
		expect(body.error.code).toBe("UNAUTHORIZED");
		expect(body.error.requestId).toBeDefined();
	});

	test("unauthenticated dev endpoint returns 401", async () => {
		const res = await app.request("/dev/authz/permissions");
		expect(res.status).toBe(401);
	});

	test("authenticated user without permission returns 403", async () => {
		const cl = appWithUser(toSafeUser(client));
		const res = await cl.request("/task", { method: "POST" });
		expect(res.status).toBe(403);
		const body = (await res.json()) as {
			error: { code: string; message: string };
		};
		expect(body.error.code).toBe("FORBIDDEN");
		expect(body.error.message).toBe(
			"You do not have permission to perform this action",
		);
	});

	test("authenticated user granted permission passes", async () => {
		const pmApp = appWithUser(toSafeUser(pm));
		const res = await pmApp.request("/task", { method: "POST" });
		expect(res.status).toBe(200);
	});

	test("requireRole rejects a different role with 403", async () => {
		const ui = appWithUser(toSafeUser(uiUx));
		const res = await ui.request("/pm-only");
		expect(res.status).toBe(403);
		const body = (await res.json()) as { error: { code: string } };
		expect(body.error.code).toBe("FORBIDDEN");
	});

	test("requireRole accepts the target role", async () => {
		const pmApp = appWithUser(toSafeUser(pm));
		const res = await pmApp.request("/pm-only");
		expect(res.status).toBe(200);
	});
});
