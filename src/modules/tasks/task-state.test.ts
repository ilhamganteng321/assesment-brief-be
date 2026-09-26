import { describe, expect, test } from "bun:test";
import type { TaskBlockingState } from "../dependencies/dependency.types";
import { canStartTask } from "./task-state.service";

describe("task state transition", () => {
	function blocking(
		overrides: Partial<TaskBlockingState> = {},
	): TaskBlockingState {
		return {
			blocked: false,
			blockedBy: [],
			...overrides,
		};
	}

	test("canStartTask allows an unblocked task", () => {
		expect(canStartTask(blocking())).toBe(true);
		expect(
			canStartTask(
				blocking({
					blocked: false,
					blockedBy: [],
				}),
			),
		).toBe(true);
	});

	test("canStartTask blocks a task with incomplete dependencies", () => {
		expect(
			canStartTask(
				blocking({
					blocked: true,
					blockedBy: [
						{
							id: "task-b",
							title: "Backend API",
							status: "IN_PROGRESS",
							deleted: false,
						},
					],
				}),
			),
		).toBe(false);
	});

	test("canStartTask treats a deleted prerequisite as a block", () => {
		expect(
			canStartTask(
				blocking({
					blocked: true,
					blockedBy: [
						{
							id: "task-a",
							title: "Removed prerequisite",
							status: "TODO",
							deleted: true,
						},
					],
				}),
			),
		).toBe(false);
	});
});
