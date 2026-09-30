import { HttpError } from "../../lib/http-error";
import type { ProjectStatus } from "../authorization/authorization.types";

export class ProjectNotFoundError extends HttpError {
	constructor() {
		super(404, "PROJECT_NOT_FOUND", "Project not found");
	}
}

/**
 * A lifecycle move the project may not make.
 *
 * A conflict rather than a bad request: the request is well formed, and the
 * project it names exists, but the two statuses are not connected by the
 * lifecycle. The names of both ends are returned so a client can rebuild its
 * controls from the error without refetching the project first.
 */
export class ProjectInvalidStatusTransitionError extends HttpError {
	constructor(from: ProjectStatus, to: ProjectStatus) {
		super(
			409,
			"INVALID_PROJECT_STATUS_TRANSITION",
			`Project cannot transition from ${from} to ${to}.`,
			{ fromStatus: from, toStatus: to },
		);
	}
}

/**
 * An archived project is read-only.
 *
 * Archiving is the end of the lifecycle, so there is no later state the record
 * could be edited back into. Rejected as a conflict so the caller can tell this
 * apart from a validation failure it could fix by retyping the form.
 */
export class ProjectArchivedError extends HttpError {
	constructor() {
		super(
			409,
			"PROJECT_ARCHIVED",
			"This project is archived and can no longer be modified",
		);
	}
}

export class ProjectAccessDeniedError extends HttpError {
	constructor(message = "You do not have permission to access this project") {
		super(403, "PROJECT_ACCESS_DENIED", message);
	}
}

export class ProjectAlreadyDeletedError extends HttpError {
	constructor() {
		super(
			409,
			"PROJECT_ALREADY_DELETED",
			"This project has already been deleted",
		);
	}
}

export class ProjectMemberNotFoundError extends HttpError {
	constructor() {
		super(404, "PROJECT_MEMBER_NOT_FOUND", "Project member not found");
	}
}

export class ProjectMemberAlreadyExistsError extends HttpError {
	constructor() {
		super(
			409,
			"PROJECT_MEMBER_ALREADY_EXISTS",
			"This user is already a member of the project",
		);
	}
}

export class ProjectUserNotFoundError extends HttpError {
	constructor() {
		super(404, "USER_NOT_FOUND", "User not found");
	}
}

/**
 * The member still owns work that is not finished.
 *
 * A conflict rather than a bad request, and the only member-management error that
 * is about something other than the request's shape. Assignment is the reason it
 * exists: `ProjectMembers` and `Tasks.assignedToId` are two independent
 * relationships, and removing the first while the second points at the removed
 * person leaves a task assigned to somebody who cannot open the project it is in.
 * That task is then unreachable for the person meant to do it and unassignable by
 * anybody else without editing it field by field.
 *
 * The count is reported because the remedy is "reassign these", and a person cannot
 * start a list they cannot see. `DONE` and soft-deleted tasks are excluded: a
 * finished task is history and a deleted one is not on anybody's desk, so neither
 * is work that would be lost.
 */
export class ProjectMemberHasActiveTasksError extends HttpError {
	constructor(count: number, memberName: string) {
		super(
			409,
			"PROJECT_MEMBER_HAS_ACTIVE_TASKS",
			`${memberName} still has ${String(count)} active ${count === 1 ? "task" : "tasks"}. Reassign ${
				count === 1 ? "it" : "them"
			} before removing the member.`,
			{ activeTaskCount: count },
		);
	}
}
