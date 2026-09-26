import { env } from "../config/env";
import { SERVICE_NAME } from "../routes/health";

export const API_TITLE = "Project Management Operational Backbone API";
export const API_VERSION = "1.0.0";
export const API_DESCRIPTION =
	"API for managing projects, tasks, dependencies, work deliverables, permissions, and audit history.";

type Schema = Record<string, unknown>;

function ref(name: string): Record<string, unknown> {
	return { $ref: `#/components/schemas/${name}` };
}

function uuidSchema(description: string): Record<string, unknown> {
	return {
		type: "string",
		format: "uuid",
		example: "00000000-0000-0000-0000-000000000000",
		description,
	};
}

function success(dataSchema: Schema): Record<string, unknown> {
	return {
		description: "Successful response",
		content: {
			"application/json": {
				schema: {
					type: "object",
					properties: {
						success: { type: "boolean", const: true },
						data: dataSchema,
					},
					required: ["success", "data"],
				},
			},
		},
	};
}

type ErrorEntry = { status: number; code: string; message: string };

function errors(entries: readonly ErrorEntry[]): Record<string, unknown> {
	const responses: Record<string, unknown> = {};
	for (const entry of entries) {
		responses[String(entry.status)] = {
			description: `${entry.message} (code: ${entry.code})`,
			content: {
				"application/json": {
					schema: ref("ErrorResponse"),
					example: {
						success: false,
						error: {
							code: entry.code,
							message: entry.message,
							requestId: "3c9a1e8a-6d5b-4f21-9c3f-8f0d1a2b3c4d",
						},
					},
				},
			},
		};
	}
	return responses;
}

const BAD_REQUEST: ErrorEntry = {
	status: 400,
	code: "INVALID_REQUEST",
	message: "Validation failed",
};
const UNAUTHORIZED: ErrorEntry = {
	status: 401,
	code: "UNAUTHORIZED",
	message: "Missing, malformed, or expired Bearer JWT",
};
const ACCESS_DENIED: ErrorEntry = {
	status: 403,
	code: "ACCESS_DENIED",
	message: "The user lacks permission for this operation",
};
const NOT_FOUND: ErrorEntry = {
	status: 404,
	code: "NOT_FOUND",
	message: "The requested resource does not exist",
};
const PAYLOAD_TOO_LARGE: ErrorEntry = {
	status: 413,
	code: "PAYLOAD_TOO_LARGE",
	message: "Request body exceeds the size limit",
};
const RATE_LIMITED: ErrorEntry = {
	status: 429,
	code: "RATE_LIMITED",
	message: "Too many requests",
};
const INTERNAL_ERROR: ErrorEntry = {
	status: 500,
	code: "INTERNAL_SERVER_ERROR",
	message: "Internal server error",
};

const COMMON_ERRORS = errors([
	BAD_REQUEST,
	UNAUTHORIZED,
	ACCESS_DENIED,
	NOT_FOUND,
	PAYLOAD_TOO_LARGE,
	RATE_LIMITED,
	INTERNAL_ERROR,
]);

function shareableErrorResponses(
	extra: readonly ErrorEntry[] = [],
): Record<string, unknown> {
	return errors([
		...extra,
		ACCESS_DENIED,
		NOT_FOUND,
		BAD_REQUEST,
		UNAUTHORIZED,
		PAYLOAD_TOO_LARGE,
		RATE_LIMITED,
		INTERNAL_ERROR,
	]);
}

function authErrors(): Record<string, unknown> {
	return errors([
		BAD_REQUEST,
		{
			status: 401,
			code: "INVALID_CREDENTIALS",
			message: "Invalid email or password",
		},
		{
			status: 409,
			code: "EMAIL_ALREADY_REGISTERED",
			message: "An account with this email already exists",
		},
		PAYLOAD_TOO_LARGE,
		RATE_LIMITED,
	]);
}

const loginErrors = errors([
	BAD_REQUEST,
	{
		status: 401,
		code: "INVALID_CREDENTIALS",
		message: "Invalid email or password",
	},
	PAYLOAD_TOO_LARGE,
	RATE_LIMITED,
]);

const bearerSecurity: readonly Record<string, unknown>[] = [{ bearerAuth: [] }];

function projectIdParam(description: string): Record<string, unknown> {
	return {
		name: "projectId",
		in: "path",
		required: true,
		schema: uuidSchema(description),
		description,
	};
}

function taskIdParam(description: string): Record<string, unknown> {
	return {
		name: "taskId",
		in: "path",
		required: true,
		schema: uuidSchema(description),
		description,
	};
}

function userIdParam(description: string): Record<string, unknown> {
	return {
		name: "userId",
		in: "path",
		required: true,
		schema: uuidSchema(description),
		description,
	};
}

function attachmentIdParam(description: string): Record<string, unknown> {
	return {
		name: "attachmentId",
		in: "path",
		required: true,
		schema: uuidSchema(description),
		description,
	};
}

function pageParam(): Record<string, unknown> {
	return {
		name: "page",
		in: "query",
		required: false,
		schema: { type: "integer", minimum: 1, default: 1 },
		description: "Page number (1-based)",
	};
}

function limitParam(): Record<string, unknown> {
	return {
		name: "limit",
		in: "query",
		required: false,
		schema: { type: "integer", minimum: 1, maximum: 100, default: 20 },
		description: "Number of items per page (max 100)",
	};
}

export const openApiDocument = {
	openapi: "3.1.0",
	info: {
		title: API_TITLE,
		version: API_VERSION,
		description: API_DESCRIPTION,
	},
	...(() => {
		const baseUrl =
			env.API_BASE_URL ??
			(env.NODE_ENV === "production"
				? undefined
				: `http://localhost:${env.PORT}`);
		return baseUrl ? { servers: [{ url: baseUrl }] } : {};
	})(),
	paths: {
		"/health": {
			get: {
				tags: ["Health"],
				summary: "Liveness probe",
				description:
					"Returns the service status without touching the database. Public, no authentication required.",
				operationId: "healthLiveness",
				responses: {
					"200": {
						description: "Service is alive",
						content: {
							"application/json": {
								schema: {
									type: "object",
									properties: {
										status: { type: "string", const: "ok" },
										service: { type: "string", example: SERVICE_NAME },
									},
									required: ["status", "service"],
								},
							},
						},
					},
				},
			},
		},
		"/health/live": {
			get: {
				tags: ["Health"],
				summary: "Process liveness",
				description:
					"Confirms the application process is alive without a database query.",
				operationId: "healthLive",
				responses: {
					"200": {
						description: "Process is alive",
						content: {
							"application/json": {
								schema: {
									type: "object",
									properties: {
										status: { type: "string", const: "ok" },
										service: { type: "string", example: SERVICE_NAME },
									},
									required: ["status", "service"],
								},
							},
						},
					},
				},
			},
		},
		"/health/ready": {
			get: {
				tags: ["Health"],
				summary: "Database readiness",
				description:
					"Verifies the backend can communicate with PostgreSQL. Returns 503 (code DATABASE_UNAVAILABLE) without exposing raw database errors when the database is unreachable.",
				operationId: "healthReady",
				responses: {
					"200": {
						description: "Database is reachable",
						content: {
							"application/json": {
								schema: {
									type: "object",
									properties: {
										status: { type: "string", const: "ready" },
										database: { type: "string", const: "connected" },
									},
									required: ["status", "database"],
								},
							},
						},
					},
					"503": {
						description: "Database is unavailable (code: DATABASE_UNAVAILABLE)",
						content: {
							"application/json": {
								schema: ref("ErrorResponse"),
							},
						},
					},
				},
			},
		},
		"/auth/register": {
			post: {
				tags: ["Authentication"],
				summary: "Register an internal account",
				description:
					"Public. Creates an INTERNAL user and returns a JWT access token. Department is optional; role is always INTERNAL (PM and CLIENT accounts are provisioned directly).",
				operationId: "authRegister",
				requestBody: {
					required: true,
					content: {
						"application/json": {
							schema: ref("RegisterRequest"),
						},
					},
				},
				responses: {
					"201": success(ref("AuthSession")),
					...authErrors(),
				},
			},
		},
		"/auth/login": {
			post: {
				tags: ["Authentication"],
				summary: "Login",
				description:
					"Public. Authenticates with email and password and returns a JWT access token. Rate limited per email address.",
				operationId: "authLogin",
				requestBody: {
					required: true,
					content: {
						"application/json": {
							schema: ref("LoginRequest"),
						},
					},
				},
				responses: {
					"200": success(ref("AuthSession")),
					...loginErrors,
				},
			},
		},
		"/auth/logout": {
			post: {
				tags: ["Authentication"],
				summary: "Logout",
				description:
					"Requires a Bearer JWT. JWTs are stateless, so this confirms the client has dropped the token; no server-side session is invalidated.",
				operationId: "authLogout",
				security: bearerSecurity,
				responses: {
					"200": {
						description: "Logged out",
						content: {
							"application/json": {
								schema: {
									type: "object",
									properties: {
										success: { type: "boolean", const: true },
										message: { type: "string" },
									},
									required: ["success", "message"],
								},
							},
						},
					},
					...errors([UNAUTHORIZED]),
				},
			},
		},
		"/auth/me": {
			get: {
				tags: ["Authentication"],
				summary: "Current user",
				description:
					"Requires a Bearer JWT. Returns the authenticated user's profile.",
				operationId: "authMe",
				security: bearerSecurity,
				responses: {
					"200": success({
						type: "object",
						properties: { user: ref("User") },
						required: ["user"],
					}),
					...errors([UNAUTHORIZED]),
				},
			},
		},
		"/projects": {
			get: {
				tags: ["Projects"],
				summary: "List projects",
				description:
					"Requires a Bearer JWT. Returns the projects visible to the authenticated user (PM: all active projects; members: their projects; CLIENT: assigned projects).",
				operationId: "listProjects",
				security: bearerSecurity,
				responses: {
					"200": success({
						type: "object",
						properties: {
							projects: { type: "array", items: ref("Project") },
						},
						required: ["projects"],
					}),
					...COMMON_ERRORS,
				},
			},
			post: {
				tags: ["Projects"],
				summary: "Create a project",
				description:
					"Requires a Bearer JWT with the PROJECT_CREATE permission (PM).",
				operationId: "createProject",
				security: bearerSecurity,
				requestBody: {
					required: true,
					content: {
						"application/json": {
							schema: ref("CreateProjectRequest"),
						},
					},
				},
				responses: {
					"201": success({
						type: "object",
						properties: { project: ref("Project") },
						required: ["project"],
					}),
					...shareableErrorResponses(),
				},
			},
		},
		"/projects/{projectId}": {
			get: {
				tags: ["Projects"],
				summary: "Get a project",
				description: "Requires a Bearer JWT and project visibility.",
				operationId: "getProject",
				security: bearerSecurity,
				parameters: [projectIdParam("Project id")],
				responses: {
					"200": success({
						type: "object",
						properties: { project: ref("Project") },
						required: ["project"],
					}),
					...COMMON_ERRORS,
				},
			},
			patch: {
				tags: ["Projects"],
				summary: "Update a project",
				description:
					"Requires a Bearer JWT with the PROJECT_UPDATE permission (PM).",
				operationId: "updateProject",
				security: bearerSecurity,
				parameters: [projectIdParam("Project id")],
				requestBody: {
					required: true,
					content: {
						"application/json": {
							schema: ref("UpdateProjectRequest"),
						},
					},
				},
				responses: {
					"200": success({
						type: "object",
						properties: { project: ref("Project") },
						required: ["project"],
					}),
					...shareableErrorResponses(),
				},
			},
			delete: {
				tags: ["Projects"],
				summary: "Soft-delete a project",
				description:
					"Requires a Bearer JWT with the PROJECT_DELETE permission (PM). Marks the project as deleted.",
				operationId: "deleteProject",
				security: bearerSecurity,
				parameters: [projectIdParam("Project id")],
				responses: {
					"204": { description: "Project soft-deleted, no content" },
					...shareableErrorResponses(),
				},
			},
		},
		"/projects/{projectId}/members": {
			get: {
				tags: ["Projects"],
				summary: "List project members",
				description: "Requires a Bearer JWT and project visibility.",
				operationId: "listProjectMembers",
				security: bearerSecurity,
				parameters: [projectIdParam("Project id")],
				responses: {
					"200": success({
						type: "object",
						properties: {
							members: { type: "array", items: ref("ProjectMember") },
						},
						required: ["members"],
					}),
					...COMMON_ERRORS,
				},
			},
			post: {
				tags: ["Projects"],
				summary: "Add a project member",
				description:
					"Requires a Bearer JWT with the permission to manage project members (PM).",
				operationId: "addProjectMember",
				security: bearerSecurity,
				parameters: [projectIdParam("Project id")],
				requestBody: {
					required: true,
					content: {
						"application/json": {
							schema: ref("AddProjectMemberRequest"),
						},
					},
				},
				responses: {
					"201": success({
						type: "object",
						properties: { member: ref("ProjectMember") },
						required: ["member"],
					}),
					...shareableErrorResponses(),
				},
			},
		},
		"/projects/{projectId}/members/{userId}": {
			delete: {
				tags: ["Projects"],
				summary: "Remove a project member",
				description:
					"Requires a Bearer JWT with the permission to manage project members (PM).",
				operationId: "removeProjectMember",
				security: bearerSecurity,
				parameters: [projectIdParam("Project id"), userIdParam("User id")],
				responses: {
					"204": { description: "Member removed, no content" },
					...shareableErrorResponses(),
				},
			},
		},
		"/projects/{projectId}/tasks": {
			get: {
				tags: ["Tasks"],
				summary: "List tasks",
				description:
					"Requires a Bearer JWT and task access in the project. Supports pagination, searching by title, and filtering by status, assignee, and client visibility.",
				operationId: "listTasks",
				security: bearerSecurity,
				parameters: [
					projectIdParam("Project id"),
					pageParam(),
					limitParam(),
					{
						name: "search",
						in: "query",
						required: false,
						schema: { type: "string", maxLength: 200 },
						description: "Substring search over the task title",
					},
					{
						name: "status",
						in: "query",
						required: false,
						schema: ref("TaskStatus"),
						description: "Filter by task status",
					},
					{
						name: "assignedToId",
						in: "query",
						required: false,
						schema: uuidSchema("User id"),
						description: "Filter by assignee",
					},
					{
						name: "clientVisible",
						in: "query",
						required: false,
						schema: { type: "boolean" },
						description: "Filter by client visibility",
					},
				],
				responses: {
					"200": success(ref("TaskList")),
					...COMMON_ERRORS,
				},
			},
			post: {
				tags: ["Tasks"],
				summary: "Create a task",
				description:
					"Requires a Bearer JWT with the TASK_CREATE permission (PM).",
				operationId: "createTask",
				security: bearerSecurity,
				parameters: [projectIdParam("Project id")],
				requestBody: {
					required: true,
					content: {
						"application/json": {
							schema: ref("CreateTaskRequest"),
						},
					},
				},
				responses: {
					"201": success({
						type: "object",
						properties: { task: ref("Task") },
						required: ["task"],
					}),
					...shareableErrorResponses(),
				},
			},
		},
		"/projects/{projectId}/tasks/{taskId}": {
			get: {
				tags: ["Tasks"],
				summary: "Get a task",
				description: "Requires a Bearer JWT and task visibility.",
				operationId: "getTask",
				security: bearerSecurity,
				parameters: [projectIdParam("Project id"), taskIdParam("Task id")],
				responses: {
					"200": success({
						type: "object",
						properties: { task: ref("Task") },
						required: ["task"],
					}),
					...COMMON_ERRORS,
				},
			},
			patch: {
				tags: ["Tasks"],
				summary: "Update a task",
				description:
					"Requires a Bearer JWT. Optimistic locking is enforced via the version field. Status changes are subject to role, membership, assignment, task state, and dependency rules: internal users may only change status on tasks assigned to them, and a task cannot move to IN_PROGRESS while required dependencies are incomplete. Only PMs may edit descriptions or change client visibility.",
				operationId: "updateTask",
				security: bearerSecurity,
				parameters: [projectIdParam("Project id"), taskIdParam("Task id")],
				requestBody: {
					required: true,
					content: {
						"application/json": {
							schema: ref("UpdateTaskRequest"),
						},
					},
				},
				responses: {
					"200": success({
						type: "object",
						properties: { task: ref("Task") },
						required: ["task"],
					}),
					...shareableErrorResponses([
						{
							status: 409,
							code: "TASK_VERSION_CONFLICT",
							message:
								"The provided version is stale; the task was updated concurrently",
						},
						{
							status: 409,
							code: "TASK_BLOCKED",
							message:
								"Task cannot move to IN_PROGRESS because required dependencies are incomplete",
						},
					]),
				},
			},
			delete: {
				tags: ["Tasks"],
				summary: "Soft-delete a task",
				description:
					"Requires a Bearer JWT with the TASK_DELETE permission (PM). Optimistic locking is enforced via the version query parameter.",
				operationId: "deleteTask",
				security: bearerSecurity,
				parameters: [
					projectIdParam("Project id"),
					taskIdParam("Task id"),
					{
						name: "version",
						in: "query",
						required: true,
						schema: { type: "integer", minimum: 1 },
						description: "Expected task version for optimistic locking",
					},
				],
				responses: {
					"204": { description: "Task soft-deleted, no content" },
					...shareableErrorResponses([
						{
							status: 409,
							code: "TASK_VERSION_CONFLICT",
							message:
								"The provided version is stale; the task was updated concurrently",
						},
					]),
				},
			},
		},
		"/projects/{projectId}/tasks/{taskId}/dependencies": {
			get: {
				tags: ["Dependencies"],
				summary: "List dependencies",
				description:
					"Requires a Bearer JWT and dependency visibility. Returns the tasks that the given task depends on.",
				operationId: "listDependencies",
				security: bearerSecurity,
				parameters: [projectIdParam("Project id"), taskIdParam("Task id")],
				responses: {
					"200": success({
						type: "object",
						properties: {
							dependencies: {
								type: "array",
								items: ref("DependencyTaskSummary"),
							},
						},
						required: ["dependencies"],
					}),
					...COMMON_ERRORS,
				},
			},
			post: {
				tags: ["Dependencies"],
				summary: "Create a dependency",
				description:
					"Requires a Bearer JWT with the TASK_DEPENDENCY_CREATE permission (PM). The dependency must be within the same project, must not be a self-dependency, and must not create a cycle.",
				operationId: "createDependency",
				security: bearerSecurity,
				parameters: [
					projectIdParam("Project id"),
					taskIdParam("Dependent task id"),
				],
				requestBody: {
					required: true,
					content: {
						"application/json": {
							schema: ref("CreateDependencyRequest"),
						},
					},
				},
				responses: {
					"201": success({
						type: "object",
						properties: { dependency: ref("TaskDependency") },
						required: ["dependency"],
					}),
					...shareableErrorResponses([
						{
							status: 400,
							code: "SELF_DEPENDENCY",
							message: "Task cannot depend on itself",
						},
						{
							status: 400,
							code: "CROSS_PROJECT_DEPENDENCY",
							message: "Dependencies must be within the same project",
						},
						{
							status: 409,
							code: "DEPENDENCY_ALREADY_EXISTS",
							message: "This dependency already exists",
						},
						{
							status: 409,
							code: "CIRCULAR_DEPENDENCY",
							message: "Creating this dependency would create a cycle",
						},
					]),
				},
			},
		},
		"/projects/{projectId}/tasks/{taskId}/dependencies/{dependencyTaskId}": {
			delete: {
				tags: ["Dependencies"],
				summary: "Remove a dependency",
				description:
					"Requires a Bearer JWT with the TASK_DEPENDENCY_DELETE permission (PM).",
				operationId: "removeDependency",
				security: bearerSecurity,
				parameters: [
					projectIdParam("Project id"),
					taskIdParam("Dependent task id"),
					{
						name: "dependencyTaskId",
						in: "path",
						required: true,
						schema: uuidSchema("Task id"),
						description: "Id of the task being depended on",
					},
				],
				responses: {
					"204": { description: "Dependency removed, no content" },
					...shareableErrorResponses(),
				},
			},
		},
		"/projects/{projectId}/tasks/{taskId}/attachments": {
			get: {
				tags: ["Attachments"],
				summary: "List attachments",
				description:
					"Requires a Bearer JWT and project attachment access. CLIENT users cannot access attachments.",
				operationId: "listAttachments",
				security: bearerSecurity,
				parameters: [
					projectIdParam("Project id"),
					taskIdParam("Task id"),
					pageParam(),
					limitParam(),
					{
						name: "mimeType",
						in: "query",
						required: false,
						schema: ref("AttachmentMimeType"),
						description: "Filter by MIME type",
					},
				],
				responses: {
					"200": success(ref("AttachmentList")),
					...COMMON_ERRORS,
				},
			},
			post: {
				tags: ["Attachments"],
				summary: "Upload an attachment",
				description:
					"Requires a Bearer JWT with the upload permission (PM/INTERNAL). Sends a single file upload as multipart/form-data with the field name `file`. Files are validated by magic bytes against an allowed MIME type allowlist.",
				operationId: "uploadAttachment",
				security: bearerSecurity,
				parameters: [projectIdParam("Project id"), taskIdParam("Task id")],
				requestBody: {
					required: true,
					content: {
						"multipart/form-data": {
							schema: {
								type: "object",
								properties: {
									file: {
										type: "string",
										format: "binary",
										description: "The file to upload",
									},
								},
								required: ["file"],
							},
						},
					},
				},
				responses: {
					"201": success({
						type: "object",
						properties: { attachment: ref("Attachment") },
						required: ["attachment"],
					}),
					...errors([
						BAD_REQUEST,
						UNAUTHORIZED,
						ACCESS_DENIED,
						{
							status: 413,
							code: "ATTACHMENT_FILE_TOO_LARGE",
							message: "The file is too large",
						},
						{
							status: 400,
							code: "ATTACHMENT_UNSUPPORTED_TYPE",
							message: "The file type is not allowed",
						},
						RATE_LIMITED,
						INTERNAL_ERROR,
					]),
				},
			},
		},
		"/projects/{projectId}/tasks/{taskId}/attachments/{attachmentId}": {
			get: {
				tags: ["Attachments"],
				summary: "Download an attachment",
				description:
					"Requires a Bearer JWT and project attachment access. Returns the raw file bytes.",
				operationId: "getAttachment",
				security: bearerSecurity,
				parameters: [
					projectIdParam("Project id"),
					taskIdParam("Task id"),
					attachmentIdParam("Attachment id"),
				],
				responses: {
					"200": {
						description: "The file content",
						content: {
							"application/octet-stream": {
								schema: { type: "string", format: "binary" },
							},
						},
					},
					...shareableErrorResponses(),
				},
			},
			delete: {
				tags: ["Attachments"],
				summary: "Soft-delete an attachment",
				description:
					"Requires a Bearer JWT and project attachment access. Marks the attachment as deleted.",
				operationId: "deleteAttachment",
				security: bearerSecurity,
				parameters: [
					projectIdParam("Project id"),
					taskIdParam("Task id"),
					attachmentIdParam("Attachment id"),
				],
				responses: {
					"204": { description: "Attachment soft-deleted, no content" },
					...shareableErrorResponses(),
				},
			},
		},
		"/projects/{projectId}/tasks/{taskId}/audit-logs": {
			get: {
				tags: ["Audit"],
				summary: "List task audit logs",
				description:
					"Requires a Bearer JWT with the AUDIT_READ permission and project access (PM, INTERNAL). Audit records are immutable: there is no write endpoint.",
				operationId: "listTaskAuditLogs",
				security: bearerSecurity,
				parameters: [
					projectIdParam("Project id"),
					taskIdParam("Task id"),
					pageParam(),
					limitParam(),
					{
						name: "changedColumn",
						in: "query",
						required: false,
						schema: ref("ChangedColumn"),
						description: "Filter by changed column",
					},
				],
				responses: {
					"200": success(ref("AuditLogList")),
					...COMMON_ERRORS,
				},
			},
		},
		"/client/dashboard": {
			get: {
				tags: ["Client"],
				summary: "Client dashboard",
				description:
					"Requires a Bearer JWT with the CLIENT role. Returns a masked, read-only summary of the client's projects and their client-visible task metrics.",
				operationId: "clientDashboard",
				security: bearerSecurity,
				responses: {
					"200": success(ref("ClientDashboard")),
					...COMMON_ERRORS,
				},
			},
		},
		"/client/projects/{projectId}/tasks": {
			get: {
				tags: ["Client"],
				summary: "List client-visible tasks",
				description:
					"Requires a Bearer JWT with the CLIENT role. Returns only explicitly client-visible tasks. Internal-only tasks are never leaked.",
				operationId: "clientListTasks",
				security: bearerSecurity,
				parameters: [
					projectIdParam("Project id"),
					pageParam(),
					limitParam(),
					{
						name: "search",
						in: "query",
						required: false,
						schema: { type: "string", maxLength: 200 },
						description: "Substring search over the task title",
					},
					{
						name: "status",
						in: "query",
						required: false,
						schema: ref("TaskStatus"),
						description: "Filter by task status",
					},
				],
				responses: {
					"200": success(ref("ClientTaskList")),
					...COMMON_ERRORS,
				},
			},
		},
		"/client/projects/{projectId}/tasks/{taskId}": {
			get: {
				tags: ["Client"],
				summary: "Get a client-visible task",
				description:
					"Requires a Bearer JWT with the CLIENT role. Returns a masked task without internal identities.",
				operationId: "clientGetTask",
				security: bearerSecurity,
				parameters: [projectIdParam("Project id"), taskIdParam("Task id")],
				responses: {
					"200": success({
						type: "object",
						properties: { task: ref("ClientTask") },
						required: ["task"],
					}),
					...COMMON_ERRORS,
				},
			},
		},
		"/docs": {
			get: {
				tags: ["Health"],
				summary: "Scalar API reference",
				description:
					"Serves the interactive Scalar documentation UI for this OpenAPI document.",
				operationId: "docs",
				responses: {
					"200": { description: "HTML documentation page" },
				},
			},
		},
		"/openapi.json": {
			get: {
				tags: ["Health"],
				summary: "OpenAPI document",
				description:
					"Returns this OpenAPI specification as JSON. The Scalar UI at /docs loads it from this endpoint.",
				operationId: "openapiJson",
				responses: {
					"200": { description: "The OpenAPI document" },
				},
			},
		},
	},
	components: {
		securitySchemes: {
			bearerAuth: {
				type: "http",
				scheme: "bearer",
				description:
					"A JWT access token returned by /auth/login or /auth/register.",
				bearerFormat: "JWT",
			},
		},
		schemas: {
			Role: {
				type: "string",
				enum: ["PM", "INTERNAL", "CLIENT"],
			},
			Department: {
				type: "string",
				enum: ["PRODUCT", "UI_UX", "FRONTEND", "BACKEND", "CLIENT"],
			},
			ProjectStatus: {
				type: "string",
				enum: ["ACTIVE", "COMPLETED", "ARCHIVED"],
			},
			TaskStatus: {
				type: "string",
				enum: ["TODO", "BLOCKED", "IN_PROGRESS", "DONE"],
			},
			AttachmentMimeType: {
				type: "string",
				enum: [
					"image/png",
					"image/jpeg",
					"image/webp",
					"application/pdf",
					"application/zip",
				],
			},
			ChangedColumn: {
				type: "string",
				enum: [
					"title",
					"description",
					"assignedToId",
					"status",
					"clientVisible",
					"deletedAt",
				],
			},
			User: {
				type: "object",
				properties: {
					id: uuidSchema("User id"),
					name: { type: "string" },
					email: { type: "string", format: "email" },
					role: ref("Role"),
					department: ref("Department"),
				},
				required: ["id", "name", "email", "role", "department"],
			},
			AuthSession: {
				type: "object",
				properties: {
					user: ref("User"),
					accessToken: {
						type: "string",
						description: "HS256 JWT access token",
					},
				},
				required: ["user", "accessToken"],
			},
			RegisterRequest: {
				type: "object",
				properties: {
					name: { type: "string", minLength: 1, maxLength: 100 },
					email: { type: "string", format: "email", maxLength: 255 },
					password: { type: "string", minLength: 8, maxLength: 72 },
					department: ref("Department"),
				},
				required: ["name", "email", "password"],
			},
			LoginRequest: {
				type: "object",
				properties: {
					email: { type: "string", format: "email", maxLength: 255 },
					password: { type: "string", minLength: 1 },
				},
				required: ["email", "password"],
			},
			Project: {
				type: "object",
				properties: {
					id: uuidSchema("Project id"),
					name: { type: "string" },
					description: { type: "string", nullable: true },
					clientName: { type: "string", nullable: true },
					status: ref("ProjectStatus"),
					createdAt: { type: "string", format: "date-time" },
					updatedAt: { type: "string", format: "date-time" },
					deletedAt: { type: "string", format: "date-time", nullable: true },
				},
				required: [
					"id",
					"name",
					"status",
					"createdAt",
					"updatedAt",
					"deletedAt",
				],
			},
			CreateProjectRequest: {
				type: "object",
				properties: {
					name: { type: "string", minLength: 1, maxLength: 150 },
					description: { type: "string", maxLength: 5000 },
					clientName: { type: "string", maxLength: 150 },
				},
				required: ["name"],
			},
			UpdateProjectRequest: {
				type: "object",
				properties: {
					name: { type: "string", maxLength: 150 },
					description: { type: "string", maxLength: 5000 },
					clientName: { type: "string", maxLength: 150 },
					status: ref("ProjectStatus"),
				},
			},
			ProjectMember: {
				type: "object",
				properties: {
					id: uuidSchema("Membership id"),
					projectId: uuidSchema("Project id"),
					userId: uuidSchema("User id"),
					createdAt: { type: "string", format: "date-time" },
					user: {
						type: "object",
						properties: {
							id: uuidSchema("User id"),
							name: { type: "string" },
							email: { type: "string", format: "email" },
						},
						required: ["id", "name", "email"],
					},
				},
				required: ["id", "projectId", "userId", "createdAt", "user"],
			},
			AddProjectMemberRequest: {
				type: "object",
				properties: {
					userId: uuidSchema("User id"),
				},
				required: ["userId"],
			},
			DependencyTaskSummary: {
				type: "object",
				properties: {
					id: uuidSchema("Task id"),
					title: { type: "string" },
					status: ref("TaskStatus"),
				},
				required: ["id", "title", "status"],
			},
			Task: {
				type: "object",
				properties: {
					id: uuidSchema("Task id"),
					projectId: uuidSchema("Project id"),
					assignedToId: uuidSchema("Assigned user id"),
					title: { type: "string" },
					description: { type: "string", nullable: true },
					status: ref("TaskStatus"),
					clientVisible: { type: "boolean" },
					version: {
						type: "integer",
						description: "Optimistic locking version",
					},
					createdAt: { type: "string", format: "date-time" },
					updatedAt: { type: "string", format: "date-time" },
					isBlocked: {
						type: "boolean",
						description:
							"True when any required dependency is not completed (computed per role)",
					},
					blockedBy: { type: "array", items: ref("DependencyTaskSummary") },
				},
				required: [
					"id",
					"projectId",
					"assignedToId",
					"title",
					"description",
					"status",
					"clientVisible",
					"version",
					"createdAt",
					"updatedAt",
					"isBlocked",
					"blockedBy",
				],
			},
			CreateTaskRequest: {
				type: "object",
				properties: {
					title: { type: "string", minLength: 1, maxLength: 200 },
					description: { type: "string", maxLength: 5000 },
					assignedToId: uuidSchema("Assigned user id"),
					status: ref("TaskStatus"),
					clientVisible: { type: "boolean" },
				},
				required: ["title"],
			},
			UpdateTaskRequest: {
				type: "object",
				properties: {
					title: { type: "string", maxLength: 200 },
					description: { type: "string", maxLength: 5000 },
					assignedToId: uuidSchema("Assigned user id"),
					status: ref("TaskStatus"),
					clientVisible: { type: "boolean" },
					version: {
						type: "integer",
						minimum: 1,
						description:
							"Expected current version; must match the stored task version",
					},
				},
				required: ["version"],
			},
			Pagination: {
				type: "object",
				properties: {
					page: { type: "integer" },
					limit: { type: "integer" },
					total: { type: "integer" },
					totalPages: { type: "integer" },
				},
				required: ["page", "limit", "total", "totalPages"],
			},
			TaskList: {
				type: "object",
				properties: {
					tasks: { type: "array", items: ref("Task") },
					pagination: ref("Pagination"),
				},
				required: ["tasks", "pagination"],
			},
			TaskDependency: {
				type: "object",
				properties: {
					id: uuidSchema("Dependency id"),
					dependentTaskId: uuidSchema("Task id"),
					dependencyTaskId: uuidSchema("Task id"),
					createdAt: { type: "string", format: "date-time" },
				},
				required: ["id", "dependentTaskId", "dependencyTaskId", "createdAt"],
			},
			CreateDependencyRequest: {
				type: "object",
				properties: {
					dependencyTaskId: uuidSchema("Task id"),
				},
				required: ["dependencyTaskId"],
			},
			Attachment: {
				type: "object",
				properties: {
					id: uuidSchema("Attachment id"),
					taskId: uuidSchema("Task id"),
					fileName: { type: "string" },
					mimeType: ref("AttachmentMimeType"),
					fileSize: { type: "integer" },
					createdAt: { type: "string", format: "date-time" },
					uploadedBy: {
						type: "object",
						properties: {
							id: uuidSchema("User id"),
							name: { type: "string" },
						},
						required: ["id", "name"],
					},
				},
				required: [
					"id",
					"taskId",
					"fileName",
					"mimeType",
					"fileSize",
					"createdAt",
					"uploadedBy",
				],
			},
			AttachmentList: {
				type: "object",
				properties: {
					attachments: { type: "array", items: ref("Attachment") },
					pagination: ref("Pagination"),
				},
				required: ["attachments", "pagination"],
			},
			AuditLog: {
				type: "object",
				properties: {
					id: uuidSchema("Audit log id"),
					taskId: uuidSchema("Task id"),
					userId: uuidSchema("Acting user id"),
					changedColumn: ref("ChangedColumn"),
					oldValue: { type: "string", nullable: true },
					newValue: { type: "string", nullable: true },
					createdAt: { type: "string", format: "date-time" },
				},
				required: ["id", "taskId", "userId", "changedColumn", "createdAt"],
			},
			AuditLogList: {
				type: "object",
				properties: {
					auditLogs: { type: "array", items: ref("AuditLog") },
					pagination: ref("Pagination"),
				},
				required: ["auditLogs", "pagination"],
			},
			ClientTask: {
				type: "object",
				properties: {
					id: uuidSchema("Task id"),
					title: { type: "string" },
					description: { type: "string", nullable: true },
					status: ref("TaskStatus"),
					clientVisible: { type: "boolean", const: true },
				},
				required: ["id", "title", "description", "status", "clientVisible"],
			},
			ClientTaskList: {
				type: "object",
				properties: {
					tasks: { type: "array", items: ref("ClientTask") },
					pagination: ref("Pagination"),
				},
				required: ["tasks", "pagination"],
			},
			ClientMetrics: {
				type: "object",
				properties: {
					total: { type: "integer" },
					completed: { type: "integer" },
					inProgress: { type: "integer" },
					todo: { type: "integer" },
					blocked: { type: "integer" },
				},
				required: ["total", "completed", "inProgress", "todo", "blocked"],
			},
			ClientProgress: {
				type: "object",
				properties: {
					percentage: { type: "integer" },
				},
				required: ["percentage"],
			},
			ClientProject: {
				type: "object",
				properties: {
					id: uuidSchema("Project id"),
					name: { type: "string" },
					progress: ref("ClientProgress"),
					tasks: ref("ClientMetrics"),
				},
				required: ["id", "name", "progress", "tasks"],
			},
			ClientDashboard: {
				type: "object",
				properties: {
					projects: { type: "array", items: ref("ClientProject") },
				},
				required: ["projects"],
			},
			ErrorResponse: {
				type: "object",
				properties: {
					success: { type: "boolean", const: false },
					error: {
						type: "object",
						properties: {
							code: {
								type: "string",
								description: "Stable machine-readable error code",
							},
							message: { type: "string" },
							requestId: {
								type: "string",
								description: "Request id for correlating logs",
							},
						},
						required: ["code", "message"],
					},
				},
				required: ["success", "error"],
			},
		},
	},
	tags: [
		{ name: "Authentication", description: "Create and manage sessions" },
		{ name: "Projects", description: "Project lifecycle and membership" },
		{
			name: "Tasks",
			description: "Task lifecycle, transitions, and optimistic locking",
		},
		{
			name: "Dependencies",
			description: "Task dependency graph and blocking rules",
		},
		{
			name: "Attachments",
			description: "Work deliverable upload/download",
		},
		{ name: "Audit", description: "Immutable change history" },
		{ name: "Client", description: "Masked, read-only client portal" },
		{
			name: "Health",
			description: "Operational probes and API metadata",
		},
	],
};

export type OpenApiDocument = typeof openApiDocument;
