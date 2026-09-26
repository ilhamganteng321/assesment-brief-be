import { z } from "zod";

export const AUDITABLE_COLUMNS = [
	"title",
	"description",
	"assignedToId",
	"status",
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
