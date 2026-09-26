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
