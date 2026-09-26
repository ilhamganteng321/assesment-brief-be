import { z } from "zod";

/**
 * Columns whose changes are meaningful user actions and therefore get an audit
 * record. Purely technical columns are deliberately excluded: `version` and
 * `updatedAt` move on every successful write, so recording them would bury the
 * real history in noise, and `version` in particular is a concurrency token
 * rather than a business value.
 */
export const AUDITABLE_COLUMNS = [
	"title",
	"description",
	"assignedToId",
	"status",
	"priority",
	"department",
	"clientVisible",
	"deletedAt",
] as const;

export type AuditableColumn = (typeof AUDITABLE_COLUMNS)[number];

const changedColumnSchema = z.enum(AUDITABLE_COLUMNS);

export const auditListQuerySchema = z.strictObject({
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
	changedColumn: changedColumnSchema.optional(),
});
