import { describe, expect, test } from "bun:test";
import type { TaskBlockingState } from "../dependencies/dependency.types";
import { canStartTask, validateStatusTransition } from "./task-state.service";

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

describe("validateStatusTransition", () => {
	const projectId = "00000000-0000-4000-8000-000000000000";
	const task = { id: "task-1", status: "TODO" } as const;

	// The dependency gate only guards a move *into* IN_PROGRESS. These cases
	// assert that the guard does not reject, which is a cheap net against a
	// change that starts gating unrelated transitions.
	//
	// Whether a genuinely blocked task is refused needs real prerequisites in
	// the database, so that half is covered by `tests/state/transitions`
	// and the integration harness rather than here.
	const unguardedTargets = ["TODO", "BLOCKED", "DONE"] as const;

	for (const target of unguardedTargets) {
		test(`a move to ${target} is not gated on dependencies`, async () => {
			await expect(
				validateStatusTransition(projectId, task, target),
			).resolves.toBeUndefined();
		});
	}

	test("a task already IN_PROGRESS is not re-gated", async () => {
		// Re-saving the same status is not a transition into the state, so it
		// must not be refused on the grounds of outstanding prerequisites.
		await expect(
			validateStatusTransition(
				projectId,
				{ id: "task-1", status: "IN_PROGRESS" },
				"IN_PROGRESS",
			),
		).resolves.toBeUndefined();
	});
});
