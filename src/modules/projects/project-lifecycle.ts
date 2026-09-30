import type { ProjectStatus } from "../authorization/authorization.types";
import { ProjectInvalidStatusTransitionError } from "./project.errors";

/**
 * The project lifecycle, in one place.
 *
 * A project only ever moves forward, one step at a time:
 *
 *     PLANNING -> ACTIVE -> COMPLETED -> ARCHIVED
 *
 * Every other pair is refused, including a move backwards and a skip such as
 * ACTIVE -> ARCHIVED. The map is exhaustive on purpose: a status missing from it
 * has no onward transition at all, so a newly added enum value is refused until
 * someone decides where it sits in the lifecycle rather than defaulting to
 * "anything goes".
 *
 * This is the single authority for the rule. The service calls
 * {@link validateProjectStatusTransition} on every write, so a request cannot
 * reach a status the map does not permit; the UI calls
 * {@link getNextProjectStatuses} to decide which controls to render. Both read
 * this table, so a control the interface offers is a transition the server
 * accepts, and one it does not offer is still refused if the request is forged.
 */
export const PROJECT_STATUS_TRANSITIONS: Readonly<
	Record<ProjectStatus, readonly ProjectStatus[]>
> = {
	PLANNING: ["ACTIVE"],
	ACTIVE: ["COMPLETED"],
	COMPLETED: ["ARCHIVED"],
	// ARCHIVED is the end of the line. There is deliberately no reopen: a
	// completed project stays read-only rather than being resurrected into the
	// active board.
	ARCHIVED: [],
};

/**
 * The statuses a project may move to from `current`.
 *
 * An empty array is the answer for a terminal status, which is what the settings
 * page renders as "no further lifecycle actions available".
 */
export function getNextProjectStatuses(
	current: ProjectStatus,
): readonly ProjectStatus[] {
	return PROJECT_STATUS_TRANSITIONS[current];
}

/** Whether a direct move from `current` to `next` is part of the lifecycle. */
export function canTransitionProjectStatus(
	current: ProjectStatus,
	next: ProjectStatus,
): boolean {
	return PROJECT_STATUS_TRANSITIONS[current].includes(next);
}

/**
 * Throws unless `current -> next` is a legal lifecycle move.
 *
 * Re-asserting the status a project already holds is not a transition and is
 * allowed through, so an idempotent retry of a request whose response was lost
 * succeeds instead of failing with a conflict the caller cannot act on.
 */
export function validateProjectStatusTransition(
	current: ProjectStatus,
	next: ProjectStatus,
): void {
	if (current === next) {
		return;
	}

	if (!canTransitionProjectStatus(current, next)) {
		throw new ProjectInvalidStatusTransitionError(current, next);
	}
}

/** A project whose lifecycle has ended: read-only, and with nowhere to go next. */
export function isArchivedProject(status: ProjectStatus): boolean {
	return status === "ARCHIVED";
}
