import { z } from "zod";

export const createDependencySchema = z.strictObject({
	dependencyTaskId: z.string().uuid("A valid task id is required"),
});

export const dependentTaskParamsSchema = z.strictObject({
	projectId: z.string().uuid("A valid project id is required"),
	taskId: z.string().uuid("A valid task id is required"),
});

export const dependencyDeleteParamsSchema = z.strictObject({
	projectId: z.string().uuid("A valid project id is required"),
	taskId: z.string().uuid("A valid task id is required"),
	dependencyTaskId: z.string().uuid("A valid task id is required"),
});

/**
 * Flat surface params. `dependencyId` is the prerequisite task id, so the value
 * a client reads out of `GET /tasks/:taskId/dependencies` is exactly the value
 * it sends back to delete that edge.
 */
export const flatDependentTaskParamsSchema = z.strictObject({
	taskId: z.string().uuid("A valid task id is required"),
});

export const flatDependencyDeleteParamsSchema = z.strictObject({
	taskId: z.string().uuid("A valid task id is required"),
	dependencyId: z.string().uuid("A valid task id is required"),
});
