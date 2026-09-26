import type { Models } from "../../prisma/contract";
import type { TaskStatus } from "../authorization/authorization.types";

export type DependencyTaskSummary = {
	id: string;
	title: string;
	status: TaskStatus;
};

export type TaskBlockingState = {
	blocked: boolean;
	blockedBy: DependencyTaskSummary[];
};

export type TaskDependencyRecord = Omit<
	Models.public_TaskDependencies,
	"dependentTask" | "dependencyTask"
>;
