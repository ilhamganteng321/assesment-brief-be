import { z } from "zod";
import { TASK_STATUSES } from "../tasks/task.schema";

export const clientProjectIdParamSchema = z.strictObject({
	projectId: z.string().uuid("A valid project id is required"),
});

export const clientTaskIdParamSchema = z.strictObject({
	projectId: z.string().uuid("A valid project id is required"),
	taskId: z.string().uuid("A valid task id is required"),
});

export const clientTaskListQuerySchema = z.strictObject({
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
	status: z.enum(TASK_STATUSES).optional(),
});
