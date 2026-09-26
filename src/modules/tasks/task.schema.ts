import { z } from "zod";
import {
	createListQuerySchema,
	enumArrayValueSchema,
	LIST_QUERY_DEFAULT_PAGE,
	LIST_QUERY_DEFAULT_ROWS,
	LIST_QUERY_MAX_ROWS,
	type ListQuery,
	uuidValueSchema,
} from "../../lib/list-query";

export const TASK_STATUSES = [
	"TODO",
	"BLOCKED",
	"IN_PROGRESS",
	"DONE",
] as const;

export const TASK_PRIORITIES = ["LOW", "MEDIUM", "HIGH", "URGENT"] as const;

/**
 * Departments that may own a task. `CLIENT` is deliberately excluded: it only
 * ever describes a user, never a unit of internal delivery work.
 */
export const TASK_DEPARTMENTS = [
	"PRODUCT",
	"UI_UX",
	"FRONTEND",
	"BACKEND",
] as const;

const titleSchema = z
	.string()
	.trim()
	.min(1, "Title is required")
	.max(200, "Title must be at most 200 characters");

const descriptionSchema = z
	.string()
	.trim()
	.max(5000, "Description must be at most 5000 characters")
	.optional();

const assignedToIdSchema = z.string().uuid("A valid user id is required");

const statusSchema = z.enum(TASK_STATUSES);

const prioritySchema = z.enum(TASK_PRIORITIES);

const departmentSchema = z.enum(TASK_DEPARTMENTS);

const versionSchema = z
	.number()
	.int("version must be an integer")
	.positive("version must be a positive integer");

export const createTaskSchema = z.strictObject({
	title: titleSchema,
	description: descriptionSchema,
	assignedToId: assignedToIdSchema.optional(),
	status: statusSchema.optional(),
	priority: prioritySchema.optional(),
	department: departmentSchema.optional(),
	clientVisible: z.boolean().optional(),
});

export const updateTaskInputSchema = z.strictObject({
	title: titleSchema.optional(),
	description: descriptionSchema,
	assignedToId: assignedToIdSchema.optional(),
	status: statusSchema.optional(),
	priority: prioritySchema.optional(),
	department: departmentSchema.optional(),
	clientVisible: z.boolean().optional(),
	version: versionSchema,
});

export const updateTaskSchema = updateTaskInputSchema.refine(
	(input) =>
		input.title !== undefined ||
		input.description !== undefined ||
		input.assignedToId !== undefined ||
		input.status !== undefined ||
		input.priority !== undefined ||
		input.department !== undefined ||
		input.clientVisible !== undefined,
	"At least one mutable field must be provided",
);

export const taskDeleteQuerySchema = z.strictObject({
	version: z.coerce
		.number()
		.int("version must be an integer")
		.positive("version must be a positive integer"),
});

const clientVisibleQuerySchema = z
	.enum(["true", "false"])
	.transform((value) => value === "true")
	.optional();

export const taskListQuerySchema = z.strictObject({
	page: z.coerce
		.number()
		.int("page must be an integer")
		.min(1, "page must be at least 1")
		.default(1),
	limit: z.coerce
		.number()
		.int("limit must be an integer")
		.min(1, "limit must be at least 1")
		.max(100, "limit must be at most 100")
		.default(20),
	search: z
		.string()
		.trim()
		.max(200, "search must be at most 200 characters")
		.optional(),
	status: statusSchema.optional(),
	assignedToId: assignedToIdSchema.optional(),
	clientVisible: clientVisibleQuerySchema,
});

export const projectIdParamSchema = z.strictObject({
	projectId: z.string().uuid("A valid project id is required"),
});

export const taskIdParamSchema = z.strictObject({
	projectId: z.string().uuid("A valid project id is required"),
	taskId: z.string().uuid("A valid task id is required"),
});

export const TASK_FILTER_FIELDS = [
	"id",
	"projectId",
	"assignedToId",
	"status",
	"priority",
	"department",
	"clientVisible",
] as const;

export const TASK_SEARCH_FIELDS = ["title", "description"] as const;

export const TASK_RANGED_FIELDS = ["createdAt", "updatedAt"] as const;

export const TASK_ORDER_FIELDS = [
	"createdAt",
	"updatedAt",
	"title",
	"status",
	"priority",
] as const;

export const DEFAULT_TASK_PAGE = LIST_QUERY_DEFAULT_PAGE;
export const DEFAULT_TASK_ROWS = LIST_QUERY_DEFAULT_ROWS;
export const MAX_TASK_ROWS = LIST_QUERY_MAX_ROWS;

export type TaskListQuery = ListQuery<
	(typeof TASK_FILTER_FIELDS)[number],
	(typeof TASK_SEARCH_FIELDS)[number],
	(typeof TASK_RANGED_FIELDS)[number],
	(typeof TASK_ORDER_FIELDS)[number]
>;

const clientVisibleFilterValueSchema = z
	.union([z.boolean(), z.enum(["true", "false"])])
	.transform((value) => value === true || value === "true");

const taskListQueryFactory = createListQuerySchema({
	entityLabel: "task",
	filterKeys: TASK_FILTER_FIELDS,
	searchKeys: TASK_SEARCH_FIELDS,
	rangedKeys: TASK_RANGED_FIELDS,
	orderKeys: TASK_ORDER_FIELDS,
	filterValueSchemas: {
		id: uuidValueSchema(),
		projectId: uuidValueSchema(),
		assignedToId: uuidValueSchema(),
		status: enumArrayValueSchema(TASK_STATUSES),
		priority: enumArrayValueSchema(TASK_PRIORITIES),
		department: enumArrayValueSchema(TASK_DEPARTMENTS),
		clientVisible: clientVisibleFilterValueSchema,
	},
	defaultRows: DEFAULT_TASK_ROWS,
	maxRows: MAX_TASK_ROWS,
});

export const taskOfficialListQuerySchema = taskListQueryFactory.schema;

export const DEFAULT_TASK_LIST_QUERY: TaskListQuery =
	taskListQueryFactory.defaultQuery;

/**
 * Flat `/tasks` create body. The project is selected by the caller, so
 * `projectId` moves from the nested path into the payload.
 */
export const createFlatTaskSchema = createTaskSchema.extend({
	projectId: z.string().uuid("A valid project id is required"),
});

export const flatTaskIdParamSchema = z.strictObject({
	taskId: z.string().uuid("A valid task id is required"),
});
