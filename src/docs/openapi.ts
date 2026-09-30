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

type ErrorEntry = {
	status: number;
	code: string;
	message: string;
	/**
	 * Extra error fields merged into the example body. Used where the client
	 * needs more than the code and message to recover.
	 */
	extraExample?: Record<string, unknown>;
};

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
							...(entry.extraExample ?? {}),
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

/**
 * Lost optimistic-lock race. The caller submitted a `version` that no longer
 * matched the stored row, so nothing was written. The example shows the
 * recovery fields the server adds on top of the standard error body: the
 * resource that moved on, the version that was expected, the version now
 * stored, and the current row so a client can refetch and replay.
 */
const CONCURRENT_MODIFICATION: ErrorEntry = {
	status: 409,
	code: "CONCURRENT_MODIFICATION",
	message:
		"This task has been modified by another user. Please refresh and try again.",
	extraExample: {
		resourceId: "7f1c1f5e-0f5a-4b0a-9f9b-3a4b5c6d7e8f",
		expectedVersion: 7,
		currentVersion: 8,
		latestTask: {
			id: "7f1c1f5e-0f5a-4b0a-9f9b-3a4b5c6d7e8f",
			title: "Frontend Implementation",
			status: "IN_PROGRESS",
			version: 8,
		},
	},
};

/**
 * A lifecycle move the project may not make.
 *
 * The request is well formed and the project exists; the two statuses simply are
 * not connected by the lifecycle. The example shows the two extra fields the
 * server adds on top of the standard error body, so a client can rebuild its
 * controls from the error without refetching the project first.
 */
const INVALID_PROJECT_STATUS_TRANSITION: ErrorEntry = {
	status: 409,
	code: "INVALID_PROJECT_STATUS_TRANSITION",
	message: "Project cannot transition from ACTIVE to ARCHIVED.",
	extraExample: { fromStatus: "ACTIVE", toStatus: "ARCHIVED" },
};

/** An archived project is read-only, so a metadata write is refused. */
const PROJECT_ARCHIVED: ErrorEntry = {
	status: 409,
	code: "PROJECT_ARCHIVED",
	message: "This project is archived and can no longer be modified",
};

/**
 * The member still owns unfinished work.
 *
 * Membership and assignment are independent relationships, so removing the first
 * while the second still points at the removed person would leave a task assigned
 * to somebody who cannot open the project it is in — invisible to the person meant
 * to do it, and unassignable by anybody else without editing each one by hand. The
 * refusal carries the count because the remedy is "reassign these", and a person
 * cannot start a list they cannot see. `DONE` and soft-deleted tasks are excluded:
 * a finished task is history and a deleted one is on nobody's desk, so neither is
 * work that would be lost.
 */
const PROJECT_MEMBER_HAS_ACTIVE_TASKS: ErrorEntry = {
	status: 409,
	code: "PROJECT_MEMBER_HAS_ACTIVE_TASKS",
	message:
		"John Doe still has 3 active tasks. Reassign them before removing the member.",
	extraExample: { activeTaskCount: 3 },
};

/** The lifecycle errors both project write routes can answer with. */
const PROJECT_LIFECYCLE_ERRORS = [
	INVALID_PROJECT_STATUS_TRANSITION,
	PROJECT_ARCHIVED,
] as const;

// ---------------------------------------------------------------------------
// Invitation errors
//
// Every one of these is a code a client branches on. The recipient-facing set in
// particular cannot be collapsed into a generic 409: "sign in as this address",
// "this link expired" and "this invitation was withdrawn" each send the person
// somewhere different, and an API that cannot tell them apart forces the frontend
// to guess from a message string.
// ---------------------------------------------------------------------------

/**
 * A refusal by role, not by project.
 *
 * One code for every invitation authorization failure, matching the member
 * routes' single `PROJECT_ACCESS_DENIED`. An invite must not be distinguishable
 * from an add-member attempt as a probing surface.
 */
const INVITATION_NOT_AUTHORIZED: ErrorEntry = {
	status: 403,
	code: "INVITATION_NOT_AUTHORIZED",
	message: "You do not have permission to manage project invitations",
};

const INVITATION_NOT_FOUND: ErrorEntry = {
	status: 404,
	code: "INVITATION_NOT_FOUND",
	message: "Invitation not found",
};

/**
 * The address already has a usable invitation.
 *
 * The remedy is resend or cancel rather than a differently shaped request, which
 * is why it is a conflict.
 */
const INVITATION_ALREADY_PENDING: ErrorEntry = {
	status: 409,
	code: "INVITATION_ALREADY_PENDING",
	message: "This email already has a pending invitation to this project",
};

/**
 * The link has passed its expiry.
 *
 * Reported from the clock rather than from a swept status column, so it is true
 * the moment the expiry passes rather than whenever a job next runs.
 */
const INVITATION_EXPIRED: ErrorEntry = {
	status: 409,
	code: "INVITATION_EXPIRED",
	message: "This invitation has expired",
};

const INVITATION_ALREADY_ACCEPTED: ErrorEntry = {
	status: 409,
	code: "INVITATION_ALREADY_ACCEPTED",
	message: "This invitation was already accepted",
};

const INVITATION_CANCELED: ErrorEntry = {
	status: 409,
	code: "INVITATION_CANCELED",
	message: "This invitation was canceled",
};

/**
 * The signed-in account is not the invited address.
 *
 * Carries `invitedEmail` so a recipient who is signed in as the wrong account — or
 * who has several — is told which address the invitation is waiting for, instead
 * of being sent to a signup form that will not match either.
 */
const INVITATION_EMAIL_MISMATCH: ErrorEntry = {
	status: 409,
	code: "INVITATION_EMAIL_MISMATCH",
	message:
		"This invitation was sent to ada@example.com. Sign in as that address to accept it.",
	extraExample: { invitedEmail: "ada@example.com" },
};

/**
 * The project can no longer be joined.
 *
 * `projectStatus` distinguishes the two cases because the recipient's next move
 * differs: a deleted project is never coming back, an archived one is a closed
 * record.
 */
const INVITATION_PROJECT_UNAVAILABLE: ErrorEntry = {
	status: 409,
	code: "INVITATION_PROJECT_UNAVAILABLE",
	message:
		"The project this invitation refers to is archived and can no longer be joined",
	extraExample: { projectStatus: "ARCHIVED" },
};

/**
 * The account is already on the project.
 *
 * Distinct from an acceptance failure: the membership exists and predates the link,
 * so the recipient should be sent to the project rather than shown an error.
 */
const INVITATION_ALREADY_MEMBER: ErrorEntry = {
	status: 409,
	code: "INVITATION_ALREADY_MEMBER",
	message: "You are already a member of this project",
};

/**
 * The mail transport refused the message.
 *
 * The only invitation error that is nobody's fault at the call site, which is why
 * it is a 502 rather than a 400: the request was valid, this server tried to
 * reach its transport, and the transport did not work. A client should offer a
 * resend rather than ask for a corrected address.
 */
const INVITATION_DELIVERY_FAILED: ErrorEntry = {
	status: 502,
	code: "INVITATION_DELIVERY_FAILED",
	message: "The invitation could not be emailed. Please try again.",
};

/**
 * The errors a recipient can meet on the preview and accept routes.
 *
 * Declared per route rather than as one shared list, because the two surfaces
 * cannot return the same things: the preview never refuses for an expired or
 * mismatched invitation — it reports the state and lets the page explain it — and
 * the management routes never return an email mismatch. A single union would
 * document errors no route produces.
 */
const INVITATION_ACCEPTANCE_ERRORS = [
	INVITATION_NOT_FOUND,
	INVITATION_EXPIRED,
	INVITATION_ALREADY_ACCEPTED,
	INVITATION_CANCELED,
	INVITATION_EMAIL_MISMATCH,
	INVITATION_PROJECT_UNAVAILABLE,
	INVITATION_ALREADY_MEMBER,
] as const;

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

function invitationIdParam(description: string): Record<string, unknown> {
	return {
		name: "invitationId",
		in: "path",
		required: true,
		schema: uuidSchema(description),
		description,
	};
}

/**
 * The emailed token, as a path parameter.
 *
 * Documented without a format constraint, because the value is opaque: it is 43
 * base64url characters and the server rejects anything else with 400, but a schema
 * `pattern` here would be a second copy of that rule that could drift from the one
 * in the request schema. The length is stated in the description instead.
 */
function invitationTokenParam(): Record<string, unknown> {
	return {
		name: "token",
		in: "path",
		required: true,
		schema: { type: "string" },
		description:
			"The 43-character token from the emailed link. 32 bytes of CSPRNG entropy, base64url encoded; only its SHA-256 digest is stored. The raw value is present in the recipient's inbox and nowhere else, which is why it travels in the path rather than a query string — the path is not written to access logs the way a query string is, and it keeps the request a plain POST with no body.",
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

/** The activity feed is capped lower than a general list: it is a headline. */
function activityLimitParam(): Record<string, unknown> {
	return {
		name: "limit",
		in: "query",
		required: false,
		schema: { type: "integer", minimum: 1, maximum: 50, default: 10 },
		description: "Number of activity entries to return (max 50)",
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
					"Requires a Bearer JWT. Returns the projects visible to the authenticated user (PM: all active projects; members: their projects; CLIENT: assigned projects). Soft-deleted projects are excluded. Every row carries a `progress` percentage computed by the server from the same aggregate the project metrics endpoint uses, so a bar in the list and the figure on the project it links to cannot disagree.",
				operationId: "listProjects",
				security: bearerSecurity,
				responses: {
					"200": success({
						type: "object",
						properties: {
							projects: { type: "array", items: ref("ProjectListItem") },
							pagination: ref("Pagination"),
						},
						required: ["projects", "pagination"],
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
					"Requires a Bearer JWT with the PROJECT_UPDATE permission (PM). Edits the project metadata. Only `name`, `description` and `clientName` are writable: the request body is a strict allow-list, so a column the product does not expose is rejected rather than passed through to the database. A `status` sent here goes through exactly the same lifecycle rule as the dedicated status route, so neither route can be used to sidestep it.",
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
					...shareableErrorResponses(PROJECT_LIFECYCLE_ERRORS),
				},
			},
			delete: {
				tags: ["Projects"],
				summary: "Soft-delete a project",
				description:
					"Requires a Bearer JWT with the PROJECT_DELETE permission (PM). Marks the project as deleted. The row, its tasks and its history are retained: a soft-deleted project disappears from the lists and cannot be read or written through any project route. It is not removed from the database, and there is no restore.",
				operationId: "deleteProject",
				security: bearerSecurity,
				parameters: [projectIdParam("Project id")],
				responses: {
					"204": { description: "Project soft-deleted, no content" },
					...shareableErrorResponses(),
				},
			},
		},
		"/projects/{projectId}/status": {
			patch: {
				tags: ["Projects"],
				summary: "Move a project along its lifecycle",
				description:
					"Requires a Bearer JWT with the PROJECT_UPDATE permission (PM). The body carries a status and nothing else, so a lifecycle move can never quietly rewrite the project's name or client. A project only ever moves forward one step at a time: `PLANNING` to `ACTIVE`, `ACTIVE` to `COMPLETED`, `COMPLETED` to `ARCHIVED`. Every other move — skipping a step, moving backwards, or reopening an archived project — is refused with 409 INVALID_PROJECT_STATUS_TRANSITION. `ARCHIVED` is terminal: there is deliberately no reopen. Re-asserting the status a project already holds succeeds without writing, so a retry of a request whose response was lost does not fail with a conflict the caller cannot act on. Archiving is not a deletion: the record, its tasks, its metrics and its history are all preserved, and an archived project becomes read-only. Completing a project is a decision about the project rather than its tasks: the move is recorded and no task status is changed.",
				operationId: "updateProjectStatus",
				security: bearerSecurity,
				parameters: [projectIdParam("Project id")],
				requestBody: {
					required: true,
					content: {
						"application/json": {
							schema: ref("UpdateProjectStatusRequest"),
						},
					},
				},
				responses: {
					"200": success({
						type: "object",
						properties: { project: ref("Project") },
						required: ["project"],
					}),
					...shareableErrorResponses(PROJECT_LIFECYCLE_ERRORS),
				},
			},
		},
		"/projects/{projectId}/metrics": {
			get: {
				tags: ["Projects"],
				summary: "Get project task metrics",
				description:
					"Requires a Bearer JWT and project visibility (PM, INTERNAL). Every count is a database aggregate, so the dashboard never derives a total in the browser. `blocked` is derived from the dependency graph rather than the stored BLOCKED status, because a task whose prerequisite is unfinished has not had its status rewritten. Progress is the share of completed tasks, computed by the server. `byDepartment` breaks the same figures down per task-owning department and reconciles exactly with the totals. Not available to a client guest, who reads the scoped `/client` payloads instead.",
				operationId: "getProjectMetrics",
				security: bearerSecurity,
				parameters: [projectIdParam("Project id")],
				responses: {
					"200": success({
						type: "object",
						properties: { metrics: ref("ProjectMetrics") },
						required: ["metrics"],
					}),
					...shareableErrorResponses(),
				},
			},
		},
		"/projects/{projectId}/activity": {
			get: {
				tags: ["Projects"],
				summary: "List recent project activity",
				description:
					"Requires a Bearer JWT and project visibility (PM, INTERNAL). Returns the project's newest audit entries, newest first, each resolved to its task title. Scoped to the tasks of this project, so a feed can never surface a change from a project the caller cannot open. Not available to a client guest: the entries name internal actors and record internal field values.",
				operationId: "getProjectActivity",
				security: bearerSecurity,
				parameters: [
					projectIdParam("Project id"),
					pageParam(),
					activityLimitParam(),
				],
				responses: {
					"200": success(ref("ProjectActivityList")),
					...shareableErrorResponses(),
				},
			},
		},
		"/projects/{projectId}/members": {
			get: {
				tags: ["Projects"],
				summary: "List project members",
				description:
					"Requires a Bearer JWT and project visibility (PM, INTERNAL). Returns the project's members with their global role and department, which is the only place the product stores a member's authority. Each user is an allow-listed projection of five fields: `passwordHash` is never read from the database, so no credential can reach this response. Not paginated, because a project's membership is a small bounded set rather than a collection that needs paging; a caller that needs a count should read it from the project instead of counting this list. A client guest is refused with 403: the client-facing payloads expose no member identities at all, and adding a masked view of them would widen what a client can learn about the internal team.",
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
					"Requires a Bearer JWT with the permission to manage project members (PM). Membership is the grant that gives an internal user access to a project and a client access to their own, so adding somebody is what opens the project to them. Adding a user who is already a member is refused with 409 PROJECT_MEMBER_ALREADY_EXISTS, both by an application-level check and by the `project_members (project_id, user_id)` unique index, so a race between two requests resolves to the same clean conflict rather than a database error. An archived project refuses new members with 409 PROJECT_ARCHIVED: the lifecycle has ended, and who is on the project is part of the record that was closed. The response is the new member, so the caller can add it to the list it already has without a second request.",
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
					...shareableErrorResponses([
						{
							status: 409,
							code: "PROJECT_MEMBER_ALREADY_EXISTS",
							message: "This user is already a member of the project",
						},
						PROJECT_ARCHIVED,
					]),
				},
			},
		},
		"/projects/{projectId}/members/candidates": {
			get: {
				tags: ["Projects"],
				summary: "Search for users to add to a project",
				description:
					"Requires a Bearer JWT with the permission to manage project members (PM). Searches the organisation by name or email for people who could be added to *this* project. It is deliberately not a user directory: the same gate that adds somebody also searches, so a role that cannot act on the results cannot enumerate the organisation either. The search runs on the server and is paged — the browser is never handed the user table. Each result is an allow-listed projection, `passwordHash` is never read, and `alreadyMember` reports who is already on the project so the interface can mark the row instead of offering it. Users already on the project are reported rather than hidden, because 'why is John not in this list' is a worse answer than 'John is already here'. Every role is eligible, deliberately: `ProjectMembers` is the only thing that associates a client with a project, so refusing client accounts would break the mechanism that gives a client access to their own work. A `search` shorter than two characters returns an empty page rather than a scan of the whole user table.",
				operationId: "searchProjectMemberCandidates",
				security: bearerSecurity,
				parameters: [
					projectIdParam("Project id"),
					{
						name: "search",
						in: "query",
						required: false,
						schema: { type: "string", maxLength: 150, default: "" },
						description:
							"Case-insensitive substring matched against the user's name and their email. Shorter than two characters matches an empty page.",
					},
					pageParam(),
					{
						name: "rows",
						in: "query",
						required: false,
						schema: {
							type: "integer",
							minimum: 1,
							maximum: 20,
							default: 10,
						},
						description:
							"Number of candidates to return (max 20). This backs a typeahead, so the ceiling is deliberately low.",
					},
				],
				responses: {
					"200": success({
						type: "object",
						properties: {
							candidates: {
								type: "array",
								items: ref("ProjectMemberCandidate"),
							},
							pagination: ref("Pagination"),
						},
						required: ["candidates", "pagination"],
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
					"Requires a Bearer JWT with the permission to manage project members (PM). Removes the membership only: the user is a real account that may own other projects, own tasks, and have a history, so taking them off one project says nothing about any of that. Removing a member revokes the project access membership grants, which takes effect on the removed user's next request. An archived project refuses removals with 409 PROJECT_ARCHIVED, and a user who is not a member is a 404 rather than a silent success, so a client can tell 'removed' from 'was never there'. A member who still owns unfinished tasks is refused with 409 PROJECT_MEMBER_HAS_ACTIVE_TASKS and `activeTaskCount`: membership and assignment are independent relationships, so removing one while the other still points at the removed person would leave their tasks assigned to somebody who can no longer open the project. Nothing is deleted, transferred or reassigned to make room — the work has to be handed over deliberately. Tasks that are DONE or soft-deleted do not block a removal, so an old project does not trap its members.",
				operationId: "removeProjectMember",
				security: bearerSecurity,
				parameters: [projectIdParam("Project id"), userIdParam("User id")],
				responses: {
					"204": { description: "Member removed, no content" },
					...shareableErrorResponses([
						PROJECT_ARCHIVED,
						PROJECT_MEMBER_HAS_ACTIVE_TASKS,
					]),
				},
			},
		},
		"/projects/{projectId}/invitations": {
			get: {
				tags: ["Invitations"],
				summary: "List a project's invitations",
				description:
					"Requires a Bearer JWT with the permission to manage project invitations (PM), the same gate that adds a member — an invitation is a membership that has not happened yet. Every invitation ever issued for the project is returned, newest first, including accepted and canceled ones: 'who was invited and what became of it' is the question this section answers, and a list that dropped its history could not answer it. Not paginated, because issuing an invitation is a deliberate PM-only act and the set cannot grow without bound through normal use. `status` is derived rather than read: a row that is PENDING but past its expiry is reported as EXPIRED, because the link stopped working when the clock passed it and a stored column nobody has swept must not report otherwise. No response and no database row ever contains the token or its hash — a dump of this table is not a list of working links. A `404` is returned for a project that does not exist; an invitation id is scoped to the project in the path, so there is no way to reach another project's invitation by probing ids.",
				operationId: "listProjectInvitations",
				security: bearerSecurity,
				parameters: [projectIdParam("Project id")],
				responses: {
					"200": success({
						type: "object",
						properties: {
							invitations: {
								type: "array",
								items: ref("ProjectInvitation"),
							},
						},
						required: ["invitations"],
					}),
					...shareableErrorResponses([INVITATION_NOT_AUTHORIZED]),
				},
			},
			post: {
				tags: ["Invitations"],
				summary: "Invite an email address to a project",
				description:
					"Requires a Bearer JWT with the permission to manage project invitations (PM). Addresses an invitation to an *email* rather than to a user, because the point is reaching somebody who has no account yet. The body is strict, so a caller reaching for the member shape is told `userId` does not exist rather than silently getting an invitation that will not match anybody. The address is trimmed and lowercased before it is stored, which is what makes the acceptance-time comparison against a signed-in address hold for an address typed in capitals. A 32-byte token is generated from the CSPRNG and only its SHA-256 digest is stored: the raw value exists in the recipient's inbox and nowhere else, so a database disclosure is not a list of ways into the project. The row is written before the mail is sent, so a link is never emailed for an invitation that does not exist, and the token is never returned in any response. If delivery fails the row is removed again and the request answers 502, so a failed send leaves no trace and the obvious retry works rather than being refused as a duplicate. A second live invitation for the same address on the same project is 409 INVITATION_ALREADY_PENDING; an address that already belongs to a member of the project is 409 PROJECT_MEMBER_ALREADY_EXISTS. A PENDING invitation whose expiry has passed does not block a new one. An archived project refuses new invitations with 409 PROJECT_ARCHIVED; a COMPLETED project allows them, matching the member endpoints, because a completed project is closed to new work rather than to membership.",
				operationId: "createProjectInvitation",
				security: bearerSecurity,
				parameters: [projectIdParam("Project id")],
				requestBody: {
					required: true,
					content: {
						"application/json": {
							schema: {
								type: "object",
								additionalProperties: false,
								properties: {
									email: {
										type: "string",
										format: "email",
										maxLength: 255,
										description:
											"Address to invite. Normalized to lowercase and trimmed before storage and before the acceptance-time comparison.",
										example: "newcomer@example.com",
									},
								},
								required: ["email"],
							},
						},
					},
				},
				responses: {
					"201": success({
						type: "object",
						properties: {
							invitation: ref("ProjectInvitation"),
						},
						required: ["invitation"],
					}),
					...shareableErrorResponses([
						INVITATION_NOT_AUTHORIZED,
						INVITATION_ALREADY_PENDING,
						INVITATION_DELIVERY_FAILED,
						PROJECT_ARCHIVED,
					]),
				},
			},
		},
		"/projects/{projectId}/invitations/{invitationId}/resend": {
			post: {
				tags: ["Invitations"],
				summary: "Reissue an invitation's token",
				description:
					"Requires a Bearer JWT with the permission to manage project invitations (PM). A resend rather than a create, so the invitation keeps its identity, its place in the project history, and the record of when it was first sent — only the credential changes: a new hash, a fresh expiry, and back to PENDING. It is a POST rather than a PATCH because the previous token stops working as a side effect, which is not an edit to the invitation's visible fields. The row is rotated *before* the mail goes out, so a PM who has asked to rotate a token and been told it worked can rely on the previous one being dead; if delivery then fails, the previous credential is restored so the recipient is not left with no working link because of a transport error. ACCEPTED is refused with 409, because the membership exists and a new link would offer to join something the recipient is already on. CANCELED and EXPIRED are both allowed: resending is how a PM revives an invitation they took back or that ran out. An archived project refuses resends with 409 PROJECT_ARCHIVED.",
				operationId: "resendProjectInvitation",
				security: bearerSecurity,
				parameters: [
					projectIdParam("Project id"),
					invitationIdParam("Invitation id"),
				],
				responses: {
					"200": success({
						type: "object",
						properties: {
							invitation: ref("ProjectInvitation"),
						},
						required: ["invitation"],
					}),
					...shareableErrorResponses([
						INVITATION_NOT_AUTHORIZED,
						INVITATION_NOT_FOUND,
						INVITATION_ALREADY_ACCEPTED,
						INVITATION_DELIVERY_FAILED,
						PROJECT_ARCHIVED,
					]),
				},
			},
		},
		"/projects/{projectId}/invitations/{invitationId}": {
			delete: {
				tags: ["Invitations"],
				summary: "Withdraw an invitation",
				description:
					"Requires a Bearer JWT with the permission to manage project invitations (PM). The membership never existed, so this only has to stop the link working. It is idempotent: cancelling an already-canceled invitation returns 204 rather than a conflict, because a PM who clicks twice has reached the state they asked for and a conflict would only teach them to reload and try again. ACCEPTED is refused with 409 — the membership it created stands, and removing that is a different, separately authorized act. The address is not banned: a later invitation to the same address succeeds, so a withdrawal is a withdrawal rather than a block. An archived project refuses cancellations with 409 PROJECT_ARCHIVED, because who may join is part of the record that was closed.",
				operationId: "cancelProjectInvitation",
				security: bearerSecurity,
				parameters: [
					projectIdParam("Project id"),
					invitationIdParam("Invitation id"),
				],
				responses: {
					"204": {
						description: "Invitation withdrawn, no content",
					},
					...shareableErrorResponses([
						INVITATION_NOT_AUTHORIZED,
						INVITATION_NOT_FOUND,
						INVITATION_ALREADY_ACCEPTED,
						PROJECT_ARCHIVED,
					]),
				},
			},
		},
		"/invitations/{token}": {
			get: {
				tags: ["Invitations"],
				summary: "Preview an invitation for its recipient",
				description:
					"Requires a Bearer JWT, and no role beyond that: this is what the acceptance page shows before anyone decides anything. The preview exists so a recipient can be told *why* they are being turned away without pressing the button first, which is why it is separate from the accept route. `usable` folds two questions together — the invitation must still be PENDING, and it must be addressed to the account that is signed in — so the screen can offer a button or say 'sign in as …' rather than presenting a control that is guaranteed to fail. `status` still reports the true state even when `usable` is false, because 'this invitation is fine, it is just not yours' is a different message from 'this invitation is dead'. The projection is deliberately the smallest in the API: anyone holding the link can call it, including someone who forwards the email, so it names the project, the sender and whether the link works and nothing else. An unknown token is 404 INVITATION_NOT_FOUND with the same code and message as a token that was never issued, so this endpoint cannot be used to confirm that a guess is real. A token that is not 43 base64url characters is rejected with 400 before any database work.",
				operationId: "getInvitationPreview",
				security: bearerSecurity,
				parameters: [invitationTokenParam()],
				responses: {
					"200": success({
						type: "object",
						properties: {
							invitation: ref("InvitationPreview"),
						},
						required: ["invitation"],
					}),
					...errors([
						BAD_REQUEST,
						UNAUTHORIZED,
						INVITATION_NOT_FOUND,
						INTERNAL_ERROR,
					]),
				},
			},
		},
		"/invitations/{token}/accept": {
			post: {
				tags: ["Invitations"],
				summary: "Accept an invitation",
				description:
					"Requires a Bearer JWT, and the authenticated account's address must equal the address the invitation was addressed to. A POST even though the effect reads like a query, because it creates a `ProjectMembers` row: a link scanner or a browser prefetch that followed a GET here would join people to projects on their behalf. The token is the only credential, and it is looked up by the SHA-256 digest of the token rather than compared, so a token matching nothing is indistinguishable from one that was never issued. The membership and the move to ACCEPTED commit in one transaction, and the status change is guarded by `status = 'PENDING'` *inside* it, so of two concurrent accepts exactly one wins and the loser is told 409 INVITATION_ALREADY_ACCEPTED instead of a duplicate membership appearing. The expiry is repeated in the same guarded statement, so a link that lapses between the read and the write is caught by the atomic predicate rather than a clock reading taken earlier. A forwarded link is useless to any other account: 409 INVITATION_EMAIL_MISMATCH, with the invited address in the body so the recipient is sent to the right account rather than to a signup form. An account that was already added to the project directly gets 409 INVITATION_ALREADY_MEMBER rather than a success implying the link granted access. A deleted or archived project is 409 INVITATION_PROJECT_UNAVAILABLE with `projectStatus` naming which.",
				operationId: "acceptInvitation",
				security: bearerSecurity,
				parameters: [invitationTokenParam()],
				responses: {
					"200": success(ref("InvitationAcceptance")),
					...errors([
						BAD_REQUEST,
						UNAUTHORIZED,
						...INVITATION_ACCEPTANCE_ERRORS,
						PAYLOAD_TOO_LARGE,
						RATE_LIMITED,
						INTERNAL_ERROR,
					]),
				},
			},
		},
		"/projects/{projectId}/tasks": {
			get: {
				tags: ["Tasks"],
				summary: "List tasks",
				description:
					"Requires a Bearer JWT and task access in the project. Supports pagination, searching by title, and filtering by status, assignee, client visibility, and calculated block state.",
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
						schema: uuidSchema("User id, or the literal `unassigned`"),
						description:
							"Filter by assignee. Accepts one user id on this nested route, and the reserved word `unassigned` for tasks with nobody on them — `IS NULL` cannot travel through a uuid, and a second filter key would be a second syntax to keep consistent. The word is a value on this key rather than a new parameter, so every uuid that worked before still works. Anything else is a 400 rather than a page that silently matches nothing.",
					},
					{
						name: "clientVisible",
						in: "query",
						required: false,
						schema: { type: "boolean" },
						description: "Filter by client visibility",
					},
					{
						name: "isBlocked",
						in: "query",
						required: false,
						schema: { type: "boolean" },
						description:
							"Filter by calculated block state. This is derived from the dependency graph rather than a stored column, so it is resolved before counting and paging: the reported total is the number of matching tasks, not the size of the page.",
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
					"Requires a Bearer JWT. Optimistic locking: send the `version` returned by the last read. The check and the write are a single atomic statement, so when the stored version has moved on nothing is written and the request is rejected with 409 CONCURRENT_MODIFICATION — a stale client can never overwrite a newer row. The version is a concurrency token only and is never settable by the client. A matching version does not bypass authorization, the task state machine, or the dependency rules. Status changes are subject to role, membership, assignment, task state, and dependency rules: internal users may only change status on tasks assigned to them, and a task cannot move to IN_PROGRESS while required dependencies are incomplete. Only PMs may edit descriptions or change client visibility. Every changed column is appended to the task's audit log inside the same transaction, so a 200 always implies the history was written, and a request rejected by the version check leaves no audit trace.",
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
						CONCURRENT_MODIFICATION,
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
					"Requires a Bearer JWT with the TASK_DELETE permission (PM). Optimistic locking is enforced via the `version` query parameter: the soft delete is the same atomic compare-and-swap as an update, so a delete and a patch that both start from the same version cannot both succeed, and a stale patch cannot resurrect a deleted task. The row is never physically removed, and the `deletedAt` transition is recorded in the audit log in the same transaction.",
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
						description:
							"Expected current task version for optimistic locking. A mismatch is answered with 409 CONCURRENT_MODIFICATION and the task is not deleted.",
					},
				],
				responses: {
					"204": { description: "Task soft-deleted, no content" },
					...shareableErrorResponses([CONCURRENT_MODIFICATION]),
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
		"/tasks": {
			get: {
				tags: ["Tasks"],
				summary: "List tasks across every project you can reach",
				description:
					'Requires a Bearer JWT with an internal role; a client guest is refused, and reads their own scoped portal instead. Every predicate is pushed into the database query, so a user cannot page past their own projects and no row is loaded only to be discarded. Unlike the nested list this one takes its filters as a single JSON object under `filters`, which is what lets a filter carry a list: `assignedToId` here accepts several user ids at once, and the reserved word `unassigned` alongside them for "or nobody\'s on it". Scoping is by membership — a project manager sees everything, an internal user only the projects they belong to — and the access scope is applied before counting, so the reported total cannot exceed what the caller may read. Each task carries its resolved `assignedTo` summary, fetched for the whole page in one query rather than one per row.',
				operationId: "listAllTasks",
				security: bearerSecurity,
				parameters: [
					{
						name: "filters",
						in: "query",
						required: false,
						schema: { type: "string" },
						description:
							"JSON object of filters. Supported keys: `id`, `projectId`, `assignedToId` (one id, an array of ids, or `unassigned`, or any mix of those), `status`, `priority`, `department`, `clientVisible`, `isBlocked`. An unknown key is a 400 rather than a silently ignored filter.",
					},
					{
						name: "searchFilters",
						in: "query",
						required: false,
						schema: { type: "string" },
						description:
							"JSON object of substring searches. Supported keys: `title`, `description`.",
					},
					{
						name: "rangedFilters",
						in: "query",
						required: false,
						schema: { type: "string" },
						description:
							"JSON array of `{ key, start?, end? }` over `createdAt` and `updatedAt`.",
					},
					pageParam(),
					{
						name: "rows",
						in: "query",
						required: false,
						schema: { type: "integer", minimum: 1, maximum: 100, default: 20 },
						description: "Number of tasks per page",
					},
					{
						name: "orderKey",
						in: "query",
						required: false,
						schema: {
							type: "string",
							enum: ["createdAt", "updatedAt", "title", "status", "priority"],
						},
						description: "Field to order by",
					},
					{
						name: "orderRule",
						in: "query",
						required: false,
						schema: { type: "string", enum: ["asc", "desc"], default: "desc" },
						description: "Sort direction",
					},
				],
				responses: {
					"200": success(ref("TaskList")),
					...COMMON_ERRORS,
				},
			},
		},
		"/tasks/my": {
			get: {
				tags: ["Tasks"],
				summary: "List the tasks assigned to you",
				description:
					'Requires a Bearer JWT with an internal role. Every task assigned to the authenticated account, across every project they are a member of, with the same status, project, search, ordering and paging filters as `GET /tasks`. The identity comes from the verified JWT and there is no userId parameter: an `assignedToId` sent in `filters` is discarded rather than honoured, because a "my tasks" view that could be pointed at somebody else\'s id would be a way to read which projects a person works on. Ignoring the parameter is also the friendlier answer than a 400 — the browser sends its shared toolbar state, and being told the filter is not allowed here would be a worse experience than having it quietly mean "you". Project scoping is inherited from the list, so a task in a project you are not a member of never appears here and is not readable directly either. Each task carries its resolved `assignedTo` summary, which is always you.',
				operationId: "listMyTasks",
				security: bearerSecurity,
				parameters: [
					{
						name: "filters",
						in: "query",
						required: false,
						schema: { type: "string" },
						description:
							"JSON object of filters, as for `GET /tasks`. `assignedToId` is ignored here: the assignee is always the caller.",
					},
					{
						name: "searchFilters",
						in: "query",
						required: false,
						schema: { type: "string" },
						description:
							"JSON object of substring searches. Supported keys: `title`, `description`.",
					},
					pageParam(),
					{
						name: "rows",
						in: "query",
						required: false,
						schema: { type: "integer", minimum: 1, maximum: 100, default: 20 },
						description: "Number of tasks per page",
					},
					{
						name: "orderKey",
						in: "query",
						required: false,
						schema: {
							type: "string",
							enum: ["createdAt", "updatedAt", "title", "status", "priority"],
						},
						description: "Field to order by",
					},
					{
						name: "orderRule",
						in: "query",
						required: false,
						schema: { type: "string", enum: ["asc", "desc"], default: "desc" },
						description: "Sort direction",
					},
				],
				responses: {
					"200": success(ref("TaskList")),
					...COMMON_ERRORS,
				},
			},
		},
		"/tasks/{taskId}/dependencies": {
			get: {
				tags: ["Dependencies"],
				summary: "List dependencies of a task",
				description:
					"Flat equivalent of the project scoped route. The owning project is resolved from the task, and the same visibility rules apply: an internal caller sees the prerequisites of a task it can access, a client guest sees only client visible, non deleted prerequisites. `deleted` marks a prerequisite whose task was soft deleted, so a dependent task never silently loses a block.",
				operationId: "listTaskDependencies",
				security: bearerSecurity,
				parameters: [taskIdParam("Task id")],
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
				summary: "Add a prerequisite to a task",
				description:
					"Requires a Bearer JWT with the TASK_DEPENDENCY_CREATE permission (PM). The prerequisite must live in the same project as the dependent task, must not be the task itself, must not already be a prerequisite, and must not create a cycle.",
				operationId: "createTaskDependency",
				security: bearerSecurity,
				parameters: [taskIdParam("Dependent task id")],
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
		"/tasks/{taskId}/dependencies/{dependencyId}": {
			delete: {
				tags: ["Dependencies"],
				summary: "Remove a prerequisite from a task",
				description:
					"Requires a Bearer JWT with the TASK_DEPENDENCY_DELETE permission (PM). `dependencyId` is the prerequisite task id, the same value returned by the list endpoint.",
				operationId: "deleteTaskDependency",
				security: bearerSecurity,
				parameters: [
					taskIdParam("Dependent task id"),
					{
						name: "dependencyId",
						in: "path",
						required: true,
						schema: uuidSchema("Task id"),
						description: "Id of the prerequisite task to detach",
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
					"Requires a Bearer JWT with the AUDIT_READ permission and project access (PM, INTERNAL). Client guests are refused with 403: the trail names internal actors and records internal field values. Audit records are immutable — there is no write endpoint, and the history is returned newest first.",
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
		"/users": {
			get: {
				tags: ["Users"],
				summary: "List users",
				description:
					"Requires a Bearer JWT with the USER_READ permission, which the permission matrix grants to PM only. A PM uses it to find somebody before putting them on a project; no other role is given it. An internal user already sees the members of their own projects, which is the subset of this list their work touches, and a client guest must never be able to enumerate the internal team — so both are refused with 403 USER_DIRECTORY_ACCESS_DENIED. Search, filtering, ordering and paging all happen in the database: the account table is the one collection here with no natural bound, and the directory is the surface where shipping it to the browser would be least defensible. Every field is named on the query, so `passwordHash` is never read from the database at all rather than being projected away afterwards. `orderKey` is validated against a closed allow-list, so nothing from the request reaches the query as a fragment.",
				operationId: "listUsers",
				security: bearerSecurity,
				parameters: [
					{
						name: "filters",
						in: "query",
						required: false,
						schema: { type: "string" },
						description:
							'JSON object of equality filters over an allow-list. Supported keys: `id` (uuid), `role` (one or more of PM, INTERNAL, CLIENT), `department` (one or more of PRODUCT, UI_UX, FRONTEND, BACKEND, CLIENT). Example: `{"role":["PM","INTERNAL"]}`.',
					},
					{
						name: "searchFilters",
						in: "query",
						required: false,
						schema: { type: "string" },
						description:
							'JSON object of case-insensitive contains filters. `name` matches either the name or the email, because people are looked up by whichever they remember; `email` matches the address alone. LIKE metacharacters are escaped, so a `%` is matched literally. Example: `{"name":"john"}`.',
					},
					{
						name: "rangedFilters",
						in: "query",
						required: false,
						schema: { type: "string" },
						description:
							'JSON array of `{ key, start, end }` over `createdAt` or `updatedAt`. Example: `[{"key":"createdAt","start":"2026-01-01"}]`.',
					},
					pageParam(),
					{
						name: "rows",
						in: "query",
						required: false,
						schema: { type: "integer", minimum: 1, maximum: 100, default: 20 },
						description: "Number of users to return (max 100)",
					},
					{
						name: "orderKey",
						in: "query",
						required: false,
						schema: {
							type: "string",
							enum: ["name", "email", "role", "department", "createdAt"],
						},
						description:
							"Column to sort by. Validated against a closed allow-list; any other value is rejected with 400 rather than passed to the query. Defaults to `createdAt`.",
					},
					{
						name: "orderRule",
						in: "query",
						required: false,
						schema: { type: "string", enum: ["asc", "desc"], default: "desc" },
						description: "Sort direction",
					},
				],
				responses: {
					"200": success({
						type: "object",
						properties: {
							users: { type: "array", items: ref("DirectoryUser") },
							pagination: ref("Pagination"),
						},
						required: ["users", "pagination"],
					}),
					...errors([
						BAD_REQUEST,
						UNAUTHORIZED,
						{
							status: 403,
							code: "USER_DIRECTORY_ACCESS_DENIED",
							message:
								"You do not have permission to browse the team directory",
						},
						RATE_LIMITED,
						INTERNAL_ERROR,
					]),
				},
			},
		},
		"/users/{userId}": {
			get: {
				tags: ["Users"],
				summary: "Get a user",
				description:
					"Requires a Bearer JWT with the USER_READ permission (PM). Returns one user's safe profile: name, address, global role, department and when the account was created. Nothing more is available — there is no route that returns a credential, a token, or any other field this one does not. A caller who lacks the permission is refused before the lookup, so the endpoint cannot be used to discover which account ids exist. Project membership is deliberately not included: reading a profile is not a way to see a person's projects, and a caller who can open a project already sees its members.",
				operationId: "getUser",
				security: bearerSecurity,
				parameters: [userIdParam("User id")],
				responses: {
					"200": success({
						type: "object",
						properties: { user: ref("DirectoryUser") },
						required: ["user"],
					}),
					...errors([
						BAD_REQUEST,
						UNAUTHORIZED,
						{
							status: 403,
							code: "USER_DIRECTORY_ACCESS_DENIED",
							message:
								"You do not have permission to browse the team directory",
						},
						{
							status: 404,
							code: "USER_NOT_FOUND",
							message: "User not found",
						},
						RATE_LIMITED,
						INTERNAL_ERROR,
					]),
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
				description:
					"The position of a project in its lifecycle. A project only ever moves forward one step at a time: `PLANNING` to `ACTIVE`, `ACTIVE` to `COMPLETED`, `COMPLETED` to `ARCHIVED`. `ARCHIVED` is terminal and there is no reopen.",
				enum: ["PLANNING", "ACTIVE", "COMPLETED", "ARCHIVED"],
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
				description:
					"A task column whose change is recorded. One entry is written per changed column, so a request that changes three fields produces three records. Purely technical columns are excluded: `version` and `updatedAt` move on every successful write and are not user actions.",
				enum: [
					"title",
					"description",
					"assignedToId",
					"status",
					"priority",
					"department",
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
				description:
					"A project as the internal API returns it. An allow-listed projection: database rows are never returned directly, so a new column cannot reach the API without a deliberate decision here. `deletedAt` is deliberately absent — a soft-deleted project is not readable at all rather than readable with a flag set.",
				properties: {
					id: uuidSchema("Project id"),
					name: { type: "string" },
					description: { type: "string", nullable: true },
					clientName: { type: "string", nullable: true },
					status: ref("ProjectStatus"),
					createdAt: { type: "string", format: "date-time" },
					updatedAt: { type: "string", format: "date-time" },
				},
				required: [
					"id",
					"name",
					"description",
					"clientName",
					"status",
					"createdAt",
					"updatedAt",
				],
			},
			ProjectListItem: {
				allOf: [
					ref("Project"),
					{
						type: "object",
						properties: {
							progress: ref("ProjectProgress"),
						},
						required: ["progress"],
					},
				],
			},
			ProjectProgress: {
				type: "object",
				properties: { percentage: { type: "integer" } },
				required: ["percentage"],
				description:
					"Completed share of live tasks as a whole percentage, computed by the server from the same aggregate the project metrics endpoint uses. A project with no live task is 0%.",
			},
			CreateProjectRequest: {
				type: "object",
				description:
					"`status` may only be set here, at creation. Once the project exists its position is moved through the lifecycle endpoint, which enforces the transition rules.",
				properties: {
					name: { type: "string", minLength: 1, maxLength: 150 },
					description: { type: "string", maxLength: 5000 },
					clientName: { type: "string", maxLength: 150 },
					status: ref("ProjectStatus"),
				},
				required: ["name"],
			},
			UpdateProjectRequest: {
				type: "object",
				description:
					"Metadata only. The body is a strict allow-list: an unknown key is rejected rather than ignored, so a client is told when it sends a field the product does not expose instead of being left believing it took effect.",
				properties: {
					name: { type: "string", minLength: 1, maxLength: 150 },
					description: { type: "string", maxLength: 5000 },
					clientName: { type: "string", maxLength: 150 },
					status: ref("ProjectStatus"),
				},
			},
			UpdateProjectStatusRequest: {
				type: "object",
				description:
					"A single required field. Metadata is refused here, so a lifecycle request can never double as a rename.",
				properties: {
					status: ref("ProjectStatus"),
				},
				required: ["status"],
			},
			ProjectMemberUser: {
				type: "object",
				description:
					"The user fields a member is allowed to see about another user. An allow-list, and the columns named on the query as well, so `passwordHash` is never read from the database and cannot reach a response. Nothing here is a security field: a name to recognise, an address to reach, the role that decides what they may do, and the team they belong to.",
				properties: {
					id: uuidSchema("User id"),
					name: { type: "string" },
					email: { type: "string", format: "email" },
					role: ref("Role"),
					department: ref("Department"),
				},
				required: ["id", "name", "email", "role", "department"],
			},
			ProjectMember: {
				type: "object",
				properties: {
					id: uuidSchema("Membership id"),
					projectId: uuidSchema("Project id"),
					userId: uuidSchema("User id"),
					createdAt: { type: "string", format: "date-time" },
					user: ref("ProjectMemberUser"),
				},
				required: ["id", "projectId", "userId", "createdAt", "user"],
			},
			ProjectMemberCandidate: {
				allOf: [
					ref("ProjectMemberUser"),
					{
						type: "object",
						properties: {
							alreadyMember: {
								type: "boolean",
								description:
									"True when this user is already on the project. Reported rather than filtered out, so the interface can explain a row instead of leaving the caller to wonder where somebody went. The write path refuses a duplicate independently.",
							},
						},
						required: ["alreadyMember"],
					},
				],
			},
			AddProjectMemberRequest: {
				type: "object",
				properties: {
					userId: uuidSchema("User id"),
				},
				required: ["userId"],
			},
			InvitationStatus: {
				type: "string",
				enum: ["PENDING", "ACCEPTED", "EXPIRED", "CANCELED"],
				description:
					"The state of an invitation. PENDING is the only state from which a link can be accepted. EXPIRED is derived from the clock rather than written: a row that is PENDING but past its expiry reports EXPIRED, because the link stopped working when the time passed and a stored column nobody has swept must not say otherwise.",
			},
			InvitationSender: {
				type: "object",
				description:
					"Who sent the invitation. The same allow-listed fields as a member summary, and named separately because a project manager has to be able to see who to ask about a pending invitation.",
				properties: {
					id: uuidSchema("User id"),
					name: { type: "string" },
					email: { type: "string", format: "email" },
				},
				required: ["id", "name", "email"],
			},
			ProjectInvitation: {
				type: "object",
				description:
					"An invitation as the project manager sees it. An allow-listed projection built field by field, so neither the token nor its hash can appear: there is no spread of the stored row for a new column to ride out on.",
				properties: {
					id: uuidSchema("Invitation id"),
					projectId: uuidSchema("Project id"),
					email: {
						type: "string",
						format: "email",
						description:
							"The invited address, normalized to lowercase. Not a user id: the recipient may have no account yet, and is resolved by address at acceptance time.",
					},
					status: ref("InvitationStatus"),
					expiresAt: {
						type: "string",
						format: "date-time",
						description:
							"After this instant the link stops working, whether or not the status column has been updated.",
					},
					acceptedAt: {
						type: "string",
						format: "date-time",
						nullable: true,
						description:
							"When the invitation was accepted, or null. Set in the same transaction as the membership it created.",
					},
					createdAt: { type: "string", format: "date-time" },
					updatedAt: { type: "string", format: "date-time" },
					invitedBy: ref("InvitationSender"),
				},
				required: [
					"id",
					"projectId",
					"email",
					"status",
					"expiresAt",
					"acceptedAt",
					"createdAt",
					"updatedAt",
					"invitedBy",
				],
			},
			InvitationPreview: {
				type: "object",
				description:
					"What the acceptance page shows. Deliberately the smallest projection in the API, because anyone holding the link can fetch it — including someone who forwards the email — so it names the project, the sender, and whether the link works for the account that is signed in, and nothing else.",
				properties: {
					email: {
						type: "string",
						format: "email",
						description:
							"The address the invitation was sent to. Always present so the screen can say 'sign in as …' when it is not the caller's own.",
					},
					project: {
						type: "object",
						properties: {
							id: uuidSchema("Project id"),
							name: { type: "string" },
						},
						required: ["id", "name"],
					},
					invitedBy: ref("InvitationSender"),
					status: ref("InvitationStatus"),
					usable: {
						type: "boolean",
						description:
							"True only when accepting would succeed right now: the invitation is PENDING, its project can still be joined, and it is addressed to the signed-in account. Folding the identity check in here is what lets the page offer a button or explain the mismatch, rather than presenting a control guaranteed to fail.",
					},
					expiresAt: { type: "string", format: "date-time" },
				},
				required: [
					"email",
					"project",
					"invitedBy",
					"status",
					"usable",
					"expiresAt",
				],
			},
			InvitationAcceptance: {
				type: "object",
				description:
					"What acceptance returns. `project` is included so the caller's next act is to open the project it was just added to, rather than a second request to find its id.",
				properties: {
					invitation: {
						type: "object",
						properties: {
							id: uuidSchema("Invitation id"),
							projectId: uuidSchema("Project id"),
							email: { type: "string", format: "email" },
							acceptedAt: { type: "string", format: "date-time" },
						},
						required: ["id", "projectId", "email", "acceptedAt"],
					},
					member: {
						type: "object",
						properties: {
							id: uuidSchema("Membership id"),
							projectId: uuidSchema("Project id"),
							userId: uuidSchema("User id"),
							createdAt: { type: "string", format: "date-time" },
						},
						required: ["id", "projectId", "userId", "createdAt"],
					},
					project: {
						type: "object",
						properties: {
							id: uuidSchema("Project id"),
							name: { type: "string" },
						},
						required: ["id", "name"],
					},
				},
				required: ["invitation", "member", "project"],
			},
			DependencyTaskSummary: {
				type: "object",
				properties: {
					id: uuidSchema("Task id"),
					title: { type: "string" },
					status: ref("TaskStatus"),
					deleted: {
						type: "boolean",
						description:
							"True when the prerequisite task has been soft deleted. The dependency row survives, so the dependent task stays blocked instead of silently becoming startable.",
					},
				},
				required: ["id", "title", "status", "deleted"],
			},
			Task: {
				type: "object",
				properties: {
					id: uuidSchema("Task id"),
					projectId: uuidSchema("Project id"),
					assignedToId: {
						...uuidSchema("Assigned user id"),
						nullable: true,
						description:
							"Who is on the task, or null when nobody is. The authoritative field: `assignedTo` below is a display copy of it, resolved server-side so a list never has to issue a request per row.",
					},
					assignedTo: {
						...ref("TaskAssignee"),
						nullable: true,
						description:
							"The assignee's display fields, or null when the task is unassigned. An allow-listed projection on both the list and the detail, so a row can name the person without an extra request. `passwordHash` and every other column of `users` are absent, and the columns named on the query are the allow-list, so the secret is never read from the database at all. A client guest never receives this field: their portal projection carries no assignment information of any kind.",
					},
					title: { type: "string" },
					description: { type: "string", nullable: true },
					status: ref("TaskStatus"),
					clientVisible: { type: "boolean" },
					version: {
						type: "integer",
						minimum: 1,
						description:
							"Current version of the row. Starts at 1 and increments by exactly 1 on every successful update, including soft delete. Echo it back as `version` on the next PATCH or DELETE.",
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
					"assignedTo",
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
			TaskAssignee: {
				type: "object",
				description:
					"The user fields a task's assignee is allowed to carry. A fixed allow-list rather than the whole `users` row: the columns named on the query are exactly these, so `passwordHash` is never selected from the database and cannot be logged or leaked by a later edit to a projection. `role` is present because the assignee control has to show what the person will be able to do once they pick the task up.",
				properties: {
					id: uuidSchema("User id"),
					name: { type: "string" },
					email: { type: "string", format: "email" },
					role: ref("Role"),
					department: ref("Department"),
				},
				required: ["id", "name", "email", "role", "department"],
			},
			CreateTaskRequest: {
				type: "object",
				properties: {
					title: { type: "string", minLength: 1, maxLength: 200 },
					description: { type: "string", maxLength: 5000 },
					assignedToId: {
						...uuidSchema("Assigned user id"),
						description:
							"Optional. The assignee must already be a member of this project: anyone else is refused with 400 TASK_ASSIGNEE_NOT_A_MEMBER, and a user id that does not exist is a 404 USER_NOT_FOUND. Membership is necessary but not sufficient — a client guest account is refused with 400 TASK_ASSIGNEE_NOT_ELIGIBLE, and an assignee whose department differs from the task's is refused with 400 TASK_DEPARTMENT_MISMATCH. Omit the field to create the task with nobody on it; `null` is not accepted here, because an unassigned task is simply one without the field.",
					},
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
					assignedToId: {
						...uuidSchema("Assigned user id"),
						nullable: true,
						description:
							"A uuid reassigns the task; `null` clears the assignment; omitting the field leaves it alone. The distinction is the whole point of accepting `null` — an omitted key means 'do not touch', which no spelling of `undefined` could express alongside an explicit 'take it off'. The same membership and eligibility rules as create apply to a uuid, and they apply again to the person the task ends up with when a request also changes `department`. Reassignment is a narrow change: it moves the assignee and nothing else — not the status, not the dependencies, not client visibility — and it records one `assignedToId` audit entry. Re-sending the same assignee is a no-op: it succeeds and writes nothing, including no audit entry.",
					},
					status: ref("TaskStatus"),
					clientVisible: { type: "boolean" },
					version: {
						type: "integer",
						minimum: 1,
						description:
							"Expected current version, taken from the task the client last read. This is a concurrency token, not a field: the server compares it against the stored row and increments it itself, so a client can never set it directly. A mismatch is answered with 409 CONCURRENT_MODIFICATION and no write.",
					},
				},
				required: ["version"],
			},
			DirectoryUser: {
				type: "object",
				description:
					"A user as the directory returns them. The columns are named on the query, so `passwordHash` is never read from the database and cannot reach a response; this schema is the whole set, and there is no route that returns more. `role` is the global role, which is the only record of a person's authority in this product — there is no per-project role.",
				properties: {
					id: uuidSchema("User id"),
					name: { type: "string" },
					email: { type: "string", format: "email" },
					role: ref("Role"),
					department: ref("Department"),
					createdAt: {
						type: "string",
						format: "date-time",
						description: "When the account was created",
					},
				},
				required: ["id", "name", "email", "role", "department", "createdAt"],
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
					createdBy: {
						...uuidSchema("User id"),
						nullable: true,
						description:
							"User that wired the edge. Null once that user has been removed.",
					},
					createdAt: { type: "string", format: "date-time" },
				},
				required: [
					"id",
					"dependentTaskId",
					"dependencyTaskId",
					"createdBy",
					"createdAt",
				],
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
			ProjectTaskMetrics: {
				type: "object",
				description:
					"Task counts for one project, produced by database aggregates. `blocked` comes from the dependency graph, not the stored BLOCKED status.",
				properties: {
					total: { type: "integer" },
					completed: { type: "integer" },
					inProgress: { type: "integer" },
					todo: { type: "integer" },
					blocked: { type: "integer" },
					unassigned: {
						type: "integer",
						description:
							'Live tasks with nobody on them. Counted directly rather than derived from `total` minus the assigned ones, so the figure reconciles against `total` and so a task whose assignee has since been removed — the orphan the member-removal guard exists to prevent — is never quietly reported as waiting for triage. Reported separately because "work with no owner" is the number a project manager acts on.',
					},
				},
				required: [
					"total",
					"completed",
					"inProgress",
					"todo",
					"blocked",
					"unassigned",
				],
			},
			ProjectMetrics: {
				type: "object",
				properties: {
					projectId: uuidSchema("Project id"),
					progress: {
						type: "object",
						properties: { percentage: { type: "integer" } },
						required: ["percentage"],
						description:
							"Share of completed tasks as a whole percentage, computed by the server so the client never introduces its own progress rule.",
					},
					tasks: ref("ProjectTaskMetrics"),
					byDepartment: {
						type: "array",
						items: ref("ProjectDepartmentMetrics"),
						description:
							"Per-department counts. The figures reconcile exactly with the project totals, and a department owning no live task is omitted rather than reported as a row of zeroes. Not exposed to a client guest.",
					},
					workload: {
						type: "array",
						items: ref("ProjectWorkloadEntry"),
						description:
							"Open work per person, busiest first, with the unassigned tasks as a row of their own. Counted in the database rather than by loading the project's tasks and tallying them, so the dashboard never has to download a project to count it. Only unfinished tasks are counted — a DONE task is history, not workload — and a member with none is omitted rather than reported as zero, so the split cannot be used to enumerate the roster. Names people, so it is internal-only like the rest of this payload.",
					},
				},
				required: [
					"projectId",
					"progress",
					"tasks",
					"byDepartment",
					"workload",
				],
			},
			ProjectWorkloadEntry: {
				type: "object",
				properties: {
					userId: {
						...uuidSchema("User id"),
						nullable: true,
						description:
							"Null for the unassigned row. Nullable rather than absent because the unassigned bucket is a real row with a real count, and splitting it into a separate field would mean the interface renders two lists of different shapes.",
					},
					name: {
						type: "string",
						description:
							"The person's display name, or the literal `Unassigned` for that row.",
					},
					department: {
						...ref("Department"),
						nullable: true,
						description: "Null for the unassigned row.",
					},
					openTaskCount: {
						type: "integer",
						description: "Unfinished, non-deleted tasks.",
					},
				},
				required: ["userId", "name", "department", "openTaskCount"],
			},
			ProjectDepartmentMetrics: {
				type: "object",
				properties: {
					department: ref("TaskDepartment"),
					total: { type: "integer" },
					completed: { type: "integer" },
					inProgress: { type: "integer" },
					todo: { type: "integer" },
					blocked: { type: "integer" },
					progressPercentage: {
						type: "integer",
						description:
							"Completed share for this department alone, computed by the server.",
					},
				},
				required: [
					"department",
					"total",
					"completed",
					"inProgress",
					"todo",
					"blocked",
					"progressPercentage",
				],
			},
			ProjectActivityEntry: {
				type: "object",
				properties: {
					id: uuidSchema("Audit log id"),
					taskId: uuidSchema("Task id"),
					taskTitle: { type: "string" },
					userId: uuidSchema("Acting user id"),
					changedColumn: ref("ChangedColumn"),
					oldValue: { type: "string", nullable: true },
					newValue: { type: "string", nullable: true },
					createdAt: { type: "string", format: "date-time" },
				},
				required: [
					"id",
					"taskId",
					"taskTitle",
					"userId",
					"changedColumn",
					"oldValue",
					"newValue",
					"createdAt",
				],
			},
			ProjectActivityList: {
				type: "object",
				properties: {
					activity: {
						type: "array",
						items: ref("ProjectActivityEntry"),
					},
					pagination: ref("Pagination"),
				},
				required: ["activity", "pagination"],
			},
			AuditLog: {
				type: "object",
				description:
					"One immutable field-level change. Append-only: the API exposes no route that updates or deletes an audit record, and a task mutation and its audit rows are written in the same transaction, so history can never disagree with the row it describes.",
				properties: {
					id: uuidSchema("Audit log id"),
					taskId: uuidSchema("Task id"),
					userId: uuidSchema(
						"Acting user id, taken from the authenticated session and never from the request body",
					),
					changedColumn: ref("ChangedColumn"),
					oldValue: {
						type: "string",
						nullable: true,
						description:
							'Serialized value before the change, read from the database. Null means the column was empty; it is never the string "null".',
					},
					newValue: {
						type: "string",
						nullable: true,
						description:
							'Serialized value after the change. Booleans are stored as "true"/"false".',
					},
					createdAt: {
						type: "string",
						format: "date-time",
						description: "Server-generated timestamp, never client supplied",
					},
				},
				required: [
					"id",
					"taskId",
					"userId",
					"changedColumn",
					"oldValue",
					"newValue",
					"createdAt",
				],
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
				description:
					"Counts over the client visible tasks of one project. `blocked` is derived from the dependency graph with internal-only prerequisites filtered out, so it reports how much client visible work is waiting without ever revealing what it is waiting on.",
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
		{
			name: "Users",
			description: "Team directory: browse and find people to work with",
		},
		{
			name: "Invitations",
			description:
				"Invite an email address to a project and accept the emailed link; access is granted only by an explicit acceptance by the invited address",
		},
		{ name: "Client", description: "Masked, read-only client portal" },
		{
			name: "Health",
			description: "Operational probes and API metadata",
		},
	],
};

export type OpenApiDocument = typeof openApiDocument;
