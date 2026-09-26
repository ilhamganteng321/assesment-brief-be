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

export const updateProjectSchema = z
	.strictObject({
		name: nameSchema.optional(),
		description: descriptionSchema,
		clientName: clientNameSchema,
		status: statusSchema.optional(),
	})
	.refine((input) => Object.keys(input).length > 0, {
		message: "At least one field must be provided",
	});

export type UpdateProjectInput = z.infer<typeof updateProjectSchema>;

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
