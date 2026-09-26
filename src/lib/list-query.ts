import { z } from "zod";

/**
 * Shared implementation of the official list query contract.
 *
 * Every list endpoint exposes exactly these parameters:
 *
 *   filters        JSON object of equality filters over an allow-list
 *   searchFilters  JSON object of case-insensitive contains filters
 *   rangedFilters  JSON array of { key, start, end } range filters
 *   page           1-based page number
 *   rows           page size
 *   orderKey       allow-listed column to order by
 *   orderRule      asc | desc
 *
 * Only allow-listed fields can ever be reached from user input, so a request can
 * never target an arbitrary column.
 */

export const LIST_QUERY_DEFAULT_PAGE = 1;
export const LIST_QUERY_DEFAULT_ROWS = 20;
export const LIST_QUERY_MAX_ROWS = 100;
export const LIST_QUERY_ORDER_RULES = ["asc", "desc"] as const;
export type ListQueryOrderRule = (typeof LIST_QUERY_ORDER_RULES)[number];

export type ListRangedFilter<TKey extends string = string> = {
	key: TKey;
	start?: string;
	end?: string;
};

export type ListQuery<
	TFilterKey extends string,
	TSearchKey extends string,
	TRangedKey extends string,
	TOrderKey extends string,
> = {
	page: number;
	rows: number;
	filters: Partial<Record<TFilterKey, unknown>>;
	searchFilters: Partial<Record<TSearchKey, string>>;
	rangedFilters: ListRangedFilter<TRangedKey>[];
	orderKey: TOrderKey | null;
	orderRule: ListQueryOrderRule;
};

export type ListQueryConfig<
	TFilterKey extends string,
	TSearchKey extends string,
	TRangedKey extends string,
	TOrderKey extends string,
> = {
	/** Human readable entity name used in validation messages. */
	entityLabel: string;
	filterKeys: readonly TFilterKey[];
	searchKeys: readonly TSearchKey[];
	rangedKeys: readonly TRangedKey[];
	orderKeys: readonly TOrderKey[];
	/** Validator per filterable field. */
	filterValueSchemas: Record<TFilterKey, z.ZodType>;
	defaultRows?: number;
	maxRows?: number;
};

export type ListQueryFactory<
	TFilterKey extends string,
	TSearchKey extends string,
	TRangedKey extends string,
	TOrderKey extends string,
> = {
	schema: z.ZodType<ListQuery<TFilterKey, TSearchKey, TRangedKey, TOrderKey>>;
	defaultQuery: ListQuery<TFilterKey, TSearchKey, TRangedKey, TOrderKey>;
};

const jsonObjectParam = (label: string) =>
	z.string().transform((value, ctx): Record<string, unknown> => {
		let parsed: unknown;

		try {
			parsed = JSON.parse(value);
		} catch {
			ctx.addIssue({
				code: "custom",
				message: `${label} must be valid JSON`,
			});
			return z.NEVER;
		}

		if (
			typeof parsed !== "object" ||
			parsed === null ||
			Array.isArray(parsed)
		) {
			ctx.addIssue({
				code: "custom",
				message: `${label} must be a JSON object`,
			});
			return z.NEVER;
		}

		return parsed as Record<string, unknown>;
	});

const jsonArrayParam = (label: string) =>
	z.string().transform((value, ctx): unknown[] => {
		let parsed: unknown;

		try {
			parsed = JSON.parse(value);
		} catch {
			ctx.addIssue({
				code: "custom",
				message: `${label} must be valid JSON`,
			});
			return z.NEVER;
		}

		if (!Array.isArray(parsed)) {
			ctx.addIssue({
				code: "custom",
				message: `${label} must be a JSON array`,
			});
			return z.NEVER;
		}

		return parsed;
	});

const stringValueSchema = z
	.string()
	.min(1, "must not be empty")
	.max(150, "must be at most 150 characters");

const searchValueSchema = z
	.string()
	.trim()
	.min(1, "must not be empty")
	.max(150, "must be at most 150 characters");

const isoDateSchema = z
	.string()
	.trim()
	.refine(
		(value) => !Number.isNaN(Date.parse(value)),
		"must be an ISO 8601 date or date-time",
	);

export function uuidValueSchema(label = "must be a valid uuid") {
	return z.string().uuid(label);
}

export function enumArrayValueSchema<TKey extends string>(
	values: readonly TKey[],
) {
	return z.union([
		z.enum(values),
		z.array(z.enum(values)).min(1, "must not be empty").max(values.length),
	]);
}

export function createListQuerySchema<
	TFilterKey extends string,
	TSearchKey extends string,
	TRangedKey extends string,
	TOrderKey extends string,
>(
	config: ListQueryConfig<TFilterKey, TSearchKey, TRangedKey, TOrderKey>,
): ListQueryFactory<TFilterKey, TSearchKey, TRangedKey, TOrderKey> {
	const {
		entityLabel,
		filterKeys,
		searchKeys,
		rangedKeys,
		orderKeys,
		filterValueSchemas,
	} = config;
	const defaultRows = config.defaultRows ?? LIST_QUERY_DEFAULT_ROWS;
	const maxRows = config.maxRows ?? LIST_QUERY_MAX_ROWS;

	const rangedFilterSchema = z.strictObject({
		key: z.enum(rangedKeys),
		start: isoDateSchema.nullish(),
		end: isoDateSchema.nullish(),
	});

	const rawSchema = z.strictObject({
		filters: jsonObjectParam("filters").optional(),
		searchFilters: jsonObjectParam("searchFilters").optional(),
		rangedFilters: jsonArrayParam("rangedFilters").optional(),
		page: z.coerce
			.number()
			.int("page must be an integer")
			.min(1, "page must be at least 1")
			.default(LIST_QUERY_DEFAULT_PAGE),
		rows: z.coerce
			.number()
			.int("rows must be an integer")
			.min(1, "rows must be at least 1")
			.max(maxRows, `rows must be at most ${maxRows}`)
			.default(defaultRows),
		orderKey: z.enum(orderKeys).optional(),
		orderRule: z.enum(LIST_QUERY_ORDER_RULES).optional(),
	});

	const parseFilters = (
		raw: Record<string, unknown> | undefined,
		ctx: z.RefinementCtx,
	): Partial<Record<TFilterKey, unknown>> => {
		if (raw === undefined) {
			return {};
		}

		const parsed: Partial<Record<TFilterKey, unknown>> = {};

		for (const [key, value] of Object.entries(raw)) {
			if (!(filterKeys as readonly string[]).includes(key)) {
				ctx.addIssue({
					code: "custom",
					message: `filters.${key} is not a filterable ${entityLabel} field`,
				});
				continue;
			}

			const validator = filterValueSchemas[key as TFilterKey];
			const result = validator.safeParse(value);

			if (!result.success) {
				ctx.addIssue({
					code: "custom",
					message: `filters.${key} ${
						result.error.issues[0]?.message ?? "is invalid"
					}`,
				});
				continue;
			}

			parsed[key as TFilterKey] = result.data;
		}

		return parsed;
	};

	const parseSearchFilters = (
		raw: Record<string, unknown> | undefined,
		ctx: z.RefinementCtx,
	): Partial<Record<TSearchKey, string>> => {
		if (raw === undefined) {
			return {};
		}

		const parsed: Partial<Record<TSearchKey, string>> = {};

		for (const [key, value] of Object.entries(raw)) {
			if (!(searchKeys as readonly string[]).includes(key)) {
				ctx.addIssue({
					code: "custom",
					message: `searchFilters.${key} is not a searchable ${entityLabel} field`,
				});
				continue;
			}

			const result = searchValueSchema.safeParse(value);

			if (!result.success) {
				ctx.addIssue({
					code: "custom",
					message: `searchFilters.${key} ${
						result.error.issues[0]?.message ?? "is invalid"
					}`,
				});
				continue;
			}

			parsed[key as TSearchKey] = result.data;
		}

		return parsed;
	};

	const parseRangedFilters = (
		raw: unknown[] | undefined,
		ctx: z.RefinementCtx,
	): ListRangedFilter<TRangedKey>[] => {
		if (raw === undefined) {
			return [];
		}

		const parsed: ListRangedFilter<TRangedKey>[] = [];

		for (const entry of raw) {
			const result = rangedFilterSchema.safeParse(entry);

			if (!result.success) {
				const issue = result.error.issues[0];
				ctx.addIssue({
					code: "custom",
					message: `rangedFilters ${issue?.message ?? "is invalid"}`,
				});
				continue;
			}

			const start = result.data.start ?? undefined;
			const end = result.data.end ?? undefined;

			if (start === undefined && end === undefined) {
				continue;
			}

			parsed.push({ key: result.data.key, start, end });
		}

		return parsed;
	};

	return {
		schema: rawSchema.transform(
			(raw, ctx): ListQuery<TFilterKey, TSearchKey, TRangedKey, TOrderKey> => ({
				page: raw.page,
				rows: raw.rows,
				filters: parseFilters(raw.filters, ctx),
				searchFilters: parseSearchFilters(raw.searchFilters, ctx),
				rangedFilters: parseRangedFilters(raw.rangedFilters, ctx),
				orderKey: raw.orderKey ?? null,
				orderRule: raw.orderRule ?? "desc",
			}),
		),
		defaultQuery: {
			page: LIST_QUERY_DEFAULT_PAGE,
			rows: defaultRows,
			filters: {},
			searchFilters: {},
			rangedFilters: [],
			orderKey: null,
			orderRule: "desc",
		},
	};
}

export { isoDateSchema, searchValueSchema, stringValueSchema };
