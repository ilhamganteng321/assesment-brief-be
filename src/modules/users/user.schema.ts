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

/**
 * The three global roles, restated as a literal.
 *
 * Not an independent list: the values are validated against these literals on the
 * way in, and the response types read them from the contract, so a role the
 * database gains and this file does not is a type error rather than a filter that
 * silently matches nothing.
 */
export const USER_ROLES = ["PM", "INTERNAL", "CLIENT"] as const;

/** Every department a person can belong to, including a client account's. */
export const USER_DEPARTMENTS = [
	"PRODUCT",
	"UI_UX",
	"FRONTEND",
	"BACKEND",
	"CLIENT",
] as const;

/**
 * Field allow-lists for the official list query contract.
 *
 * Only these fields can be reached from user supplied query parameters, so a
 * request can never target an arbitrary column — and `orderKey` in particular is
 * a closed set rather than a fragment, which is what makes it safe to sort by.
 */
export const USER_FILTER_FIELDS = ["id", "role", "department"] as const;
export const USER_SEARCH_FIELDS = ["name", "email"] as const;
export const USER_RANGED_FIELDS = ["createdAt", "updatedAt"] as const;
export const USER_ORDER_FIELDS = [
	"name",
	"email",
	"role",
	"department",
	"createdAt",
] as const;

export const DEFAULT_USER_PAGE = LIST_QUERY_DEFAULT_PAGE;
export const DEFAULT_USER_ROWS = LIST_QUERY_DEFAULT_ROWS;
export const MAX_USER_ROWS = LIST_QUERY_MAX_ROWS;

export type UserListQuery = ListQuery<
	(typeof USER_FILTER_FIELDS)[number],
	(typeof USER_SEARCH_FIELDS)[number],
	(typeof USER_RANGED_FIELDS)[number],
	(typeof USER_ORDER_FIELDS)[number]
>;

const userListQueryFactory = createListQuerySchema({
	entityLabel: "user",
	filterKeys: USER_FILTER_FIELDS,
	searchKeys: USER_SEARCH_FIELDS,
	rangedKeys: USER_RANGED_FIELDS,
	orderKeys: USER_ORDER_FIELDS,
	filterValueSchemas: {
		id: uuidValueSchema(),
		// Arrays are accepted by the shared contract, so "PM or INTERNAL" is one
		// request rather than two.
		role: enumArrayValueSchema(USER_ROLES),
		department: enumArrayValueSchema(USER_DEPARTMENTS),
	},
	defaultRows: DEFAULT_USER_ROWS,
	maxRows: MAX_USER_ROWS,
});

export const userListQuerySchema = userListQueryFactory.schema;

export const DEFAULT_USER_LIST_QUERY: UserListQuery =
	userListQueryFactory.defaultQuery;

export const userIdParamsSchema = z.strictObject({
	userId: z.string().uuid("A valid user id is required"),
});
