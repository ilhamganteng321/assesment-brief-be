import { z } from "zod";
import {
	createListQuerySchema,
	enumArrayValueSchema,
	LIST_QUERY_DEFAULT_PAGE,
	LIST_QUERY_DEFAULT_ROWS,
	LIST_QUERY_MAX_ROWS,
	type ListQuery,
	stringValueSchema,
	uuidValueSchema,
} from "../../lib/list-query";

export const PROJECT_STATUSES = [
	"PLANNING",
	"ACTIVE",
	"COMPLETED",
	"ARCHIVED",
] as const;

export type ProjectStatusInput = (typeof PROJECT_STATUSES)[number];

/**
 * Field allow-lists for the official list query contract. Only these fields can
 * be reached from user supplied query parameters, so a request can never target
 * an arbitrary column.
 */
export const PROJECT_FILTER_FIELDS = ["status", "id", "clientName"] as const;
export const PROJECT_SEARCH_FIELDS = ["name", "clientName"] as const;
export const PROJECT_RANGED_FIELDS = ["createdAt", "updatedAt"] as const;
export const PROJECT_ORDER_FIELDS = [
	"createdAt",
	"updatedAt",
	"name",
	"status",
] as const;

export const DEFAULT_PROJECT_PAGE = LIST_QUERY_DEFAULT_PAGE;
export const DEFAULT_PROJECT_ROWS = LIST_QUERY_DEFAULT_ROWS;
export const MAX_PROJECT_ROWS = LIST_QUERY_MAX_ROWS;

const nameSchema = z
	.string()
	.trim()
	.min(1, "Name is required")
	.max(150, "Name must be at most 150 characters");

const descriptionSchema = z
	.string()
	.trim()
	.max(5000, "Description must be at most 5000 characters")
	.optional();

const clientNameSchema = z
	.string()
	.trim()
	.max(150, "Client name must be at most 150 characters")
	.optional();

const statusSchema = z.enum(PROJECT_STATUSES);

export const createProjectSchema = z.strictObject({
	name: nameSchema,
	description: descriptionSchema,
	clientName: clientNameSchema,
	status: statusSchema.optional(),
});

export type CreateProjectInput = z.infer<typeof createProjectSchema>;

/**
 * The editable project metadata, and nothing else.
 *
 * The general update route copies these three fields one at a time into the
 * database write and types the result as a partial project row, so a request can
 * never carry a column through that the product does not expose. The single
 * lifecycle field is handled separately, by the status route.
 */
const projectMetadataSchema = z.strictObject({
	name: nameSchema.optional(),
	description: descriptionSchema,
	clientName: clientNameSchema,
});

/**
 * The body accepted by `PATCH /projects/:projectId`.
 *
 * `status` is accepted here so the existing single-update route keeps working,
 * but the lifecycle rule is applied to it on the way through, so this route is
 * not a way around the dedicated status endpoint. Anything the product does not
 * expose is rejected outright rather than ignored.
 */
export const updateProjectRequestSchema = projectMetadataSchema
	.extend({ status: statusSchema.optional() })
	.refine((input) => Object.keys(input).length > 0, {
		message: "At least one field must be provided",
	});

export type UpdateProjectInput = z.infer<typeof updateProjectRequestSchema>;

/**
 * The body accepted by `PATCH /projects/:projectId/status`.
 *
 * A single required field, so a status change is a lifecycle move and nothing
 * else. Metadata belongs to the general update route; mixing the two here would
 * mean a "status" request could quietly rename a project.
 */
export const updateProjectStatusSchema = z.strictObject({
	status: statusSchema,
});

export type UpdateProjectStatusInput = z.infer<
	typeof updateProjectStatusSchema
>;

export type ProjectFilters = Partial<
	Record<
		(typeof PROJECT_FILTER_FIELDS)[number],
		string | string[] | ProjectStatusInput | ProjectStatusInput[]
	>
>;
export type ProjectSearchFilters = Partial<
	Record<(typeof PROJECT_SEARCH_FIELDS)[number], string>
>;
export type ProjectRangedFilters = Array<{
	key: (typeof PROJECT_RANGED_FIELDS)[number];
	start?: string;
	end?: string;
}>;

export type ProjectListQuery = ListQuery<
	(typeof PROJECT_FILTER_FIELDS)[number],
	(typeof PROJECT_SEARCH_FIELDS)[number],
	(typeof PROJECT_RANGED_FIELDS)[number],
	(typeof PROJECT_ORDER_FIELDS)[number]
>;

const projectListQueryFactory = createListQuerySchema({
	entityLabel: "project",
	filterKeys: PROJECT_FILTER_FIELDS,
	searchKeys: PROJECT_SEARCH_FIELDS,
	rangedKeys: PROJECT_RANGED_FIELDS,
	orderKeys: PROJECT_ORDER_FIELDS,
	filterValueSchemas: {
		status: enumArrayValueSchema(PROJECT_STATUSES),
		id: uuidValueSchema(),
		clientName: stringValueSchema,
	},
	defaultRows: DEFAULT_PROJECT_ROWS,
	maxRows: MAX_PROJECT_ROWS,
});

export const projectListQuerySchema = projectListQueryFactory.schema;

export const DEFAULT_PROJECT_LIST_QUERY: ProjectListQuery =
	projectListQueryFactory.defaultQuery;

export const projectIdParamsSchema = z.strictObject({
	projectId: z.string().uuid("A valid project id is required"),
});

export const projectMemberParamsSchema = z.strictObject({
	projectId: z.string().uuid("A valid project id is required"),
	userId: z.string().uuid("A valid user id is required"),
});

export const addProjectMemberSchema = z.strictObject({
	userId: z.string().uuid("A valid user id is required"),
});

export type AddProjectMemberInput = z.infer<typeof addProjectMemberSchema>;

/**
 * Minimum characters before a candidate search is worth running.
 *
 * A shorter prefix matches most of the organisation, so the request would cost
 * the server a scan and tell the caller nothing they did not already know. The
 * endpoint returns an empty page below this rather than erroring, so a caller
 * that asks anyway gets an answer instead of a 400.
 */
export const MIN_MEMBER_CANDIDATE_SEARCH = 2;

/** Page size for a candidate search. Small: it backs a typeahead, not a report. */
export const MAX_MEMBER_CANDIDATE_ROWS = 20;

/**
 * The query contract for `GET /projects/:projectId/members/candidates`.
 *
 * A plain `search` plus paging rather than the full list-query contract, because
 * this backs a typeahead over one project: there is nothing to filter by, order
 * by, or range over, and the searchable surface is a name and an email matched
 * together. The candidate set is the whole organisation, so it is searched and
 * paged on the server — the browser is never handed the user table to filter.
 */
export const projectMemberCandidatesQuerySchema = z.strictObject({
	search: z
		.string()
		.trim()
		.max(150, "search must be at most 150 characters")
		.default(""),
	page: z.coerce
		.number()
		.int("page must be an integer")
		.min(1, "page must be at least 1")
		.default(1),
	rows: z.coerce
		.number()
		.int("rows must be an integer")
		.min(1, "rows must be at least 1")
		.max(
			MAX_MEMBER_CANDIDATE_ROWS,
			`rows must be at most ${MAX_MEMBER_CANDIDATE_ROWS}`,
		)
		.default(10),
});

export type ProjectMemberCandidatesQuery = z.infer<
	typeof projectMemberCandidatesQuerySchema
>;

/**
 * Paging for the project activity feed. The cap keeps one request from pulling an
 * unbounded slice of the audit log.
 */
export const projectActivityQuerySchema = z.strictObject({
	page: z.coerce
		.number()
		.int("page must be an integer")
		.min(1, "page must be at least 1")
		.default(1),
	limit: z.coerce
		.number()
		.int("limit must be an integer")
		.min(1, "limit must be at least 1")
		.max(50, "limit must be at most 50")
		.default(10),
});

export type ProjectActivityQuery = z.infer<typeof projectActivityQuerySchema>;
