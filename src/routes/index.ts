import { Hono } from "hono";
import { env } from "../config/env";
import type { RequestIdVariables } from "../middleware/request-id";
import { attachmentRoutes } from "../modules/attachments/attachment.routes";
import { auditRoutes } from "../modules/audit/audit.routes";
import { authRoutes } from "../modules/auth/auth.routes";
import { clientRoutes } from "../modules/client/client.routes";
import {
	dependencyRoutes,
	flatDependencyRoutes,
} from "../modules/dependencies/dependency.routes";
import {
	flatInvitationRoutes,
	projectInvitationRoutes,
} from "../modules/invitations/invitation.routes";
import { projectRoutes } from "../modules/projects/project.routes";
import { flatTaskRoutes, taskRoutes } from "../modules/tasks/task.routes";
import { userRoutes } from "../modules/users/user.routes";
import { devRoutes } from "./dev";
import { docsRoutes } from "./docs";
import { healthRoutes } from "./health";

export const routes = new Hono<{ Variables: RequestIdVariables }>();

routes.route("/health", healthRoutes);

routes.route("/auth", authRoutes);

routes.route("/projects", projectRoutes);

routes.route("/projects", projectInvitationRoutes);

routes.route("/projects", taskRoutes);

routes.route("/tasks", flatTaskRoutes);

routes.route("/tasks", flatDependencyRoutes);

routes.route("/projects", dependencyRoutes);

routes.route("/projects", auditRoutes);

routes.route("/projects", attachmentRoutes);

routes.route("/", flatInvitationRoutes);

routes.route("/client", clientRoutes);

routes.route("/users", userRoutes);

if (env.NODE_ENV !== "production") {
	routes.route("/dev", devRoutes);
}

routes.route("/", docsRoutes);
