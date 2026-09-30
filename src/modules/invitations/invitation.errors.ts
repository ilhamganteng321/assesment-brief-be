import { HttpError } from "../../lib/http-error";
import type { InvitationStatus } from "./invitation.types";

/**
 * Invitation errors.
 *
 * A module of its own rather than additions to `project.errors.ts`, because
 * invitation failures are the ones a recipient's browser sees and the codes are
 * contract surface: the frontend has to tell "you are not signed in as the
 * invited address" apart from "this link has expired", and it can only do that
 * from the code.
 *
 * Every code here is chosen so the frontend can rebuild the screen from the
 * error alone, without refetching anything.
 */

export class InvitationNotFoundError extends HttpError {
	constructor() {
		super(404, "INVITATION_NOT_FOUND", "Invitation not found");
	}
}

/**
 * A malformed or unknown token, reported as not-found.
 *
 * The same code and the same message as a genuinely absent row. An invitation
 * that does not exist and one whose token was never issued are the same fact to
 * the caller, and distinguishing them would turn this endpoint into an oracle
 * that confirms a guess.
 */
export class InvalidInvitationTokenError extends HttpError {
	constructor() {
		super(404, "INVITATION_NOT_FOUND", "Invitation not found");
	}
}

/**
 * The address already has a live invitation for this project.
 *
 * A conflict rather than a bad request: the request is well formed, but the
 * thing it asks for already exists. The remedy is resend or cancel, not a
 * differently-shaped request.
 */
export class InvitationAlreadyPendingError extends HttpError {
	constructor() {
		super(
			409,
			"INVITATION_ALREADY_PENDING",
			"This email already has a pending invitation to this project",
		);
	}
}

export class InvitationExpiredError extends HttpError {
	constructor() {
		super(409, "INVITATION_EXPIRED", "This invitation has expired");
	}
}

export class InvitationAlreadyAcceptedError extends HttpError {
	constructor() {
		super(
			409,
			"INVITATION_ALREADY_ACCEPTED",
			"This invitation was already accepted",
		);
	}
}

export class InvitationCanceledError extends HttpError {
	constructor() {
		super(409, "INVITATION_CANCELED", "This invitation was canceled");
	}
}

/**
 * The signed-in account is not the one the invitation was addressed to.
 *
 * The one case that must not be hidden: the recipient is told to sign in as the
 * invited address, and an answer of "not found" would send them to create a new
 * account instead. `invitedEmail` is included because a person who has several
 * accounts, or has mistyped their own address into the login form, needs to see
 * which address the invitation is waiting for.
 *
 * `409` rather than `403`: nothing is being refused by an authorization rule,
 * the request is just aimed at the wrong identity.
 */
export class InvitationEmailMismatchError extends HttpError {
	constructor(invitedEmail: string) {
		super(
			409,
			"INVITATION_EMAIL_MISMATCH",
			`This invitation was sent to ${invitedEmail}. Sign in as that address to accept it.`,
			{ invitedEmail },
		);
	}
}

/**
 * The invitation's project cannot be joined: deleted, or archived.
 *
 * Distinct from the status codes because the remedy differs. A deleted project
 * can never be joined and the invitation should simply stop existing; an
 * archived one is a closed record, and the message says so rather than implying
 * a retry might work.
 */
export class InvitationProjectUnavailableError extends HttpError {
	constructor(status: "ARCHIVED" | "DELETED") {
		super(
			409,
			"INVITATION_PROJECT_UNAVAILABLE",
			status === "DELETED"
				? "The project this invitation refers to no longer exists"
				: "The project this invitation refers to is archived and can no longer be joined",
			{ projectStatus: status },
		);
	}
}

/**
 * The signed-in account is already on the project.
 *
 * Reached when the membership exists but the invitation row is still pending —
 * usually because the recipient was added directly, or accepted an earlier
 * invitation that was resent. Not a failure of the token, so the caller is told
 * the outcome rather than asked to try again.
 */
export class InvitationRecipientAlreadyMemberError extends HttpError {
	constructor() {
		super(
			409,
			"INVITATION_ALREADY_MEMBER",
			"You are already a member of this project",
		);
	}
}

/**
 * Managing invitations is PM-only.
 *
 * The same message and the same code as the other project-authorization
 * failures, so an invite cannot be distinguished from an add-member attempt as
 * a probing surface.
 */
export class InvitationNotAuthorizedError extends HttpError {
	constructor(
		message = "You do not have permission to manage project invitations",
	) {
		super(403, "INVITATION_NOT_AUTHORIZED", message);
	}
}

/**
 * An email delivery failure.
 *
 * The only case in the module that is not the caller's fault and not a
 * validation problem, so it is a `502`: this server tried to reach its mail
 * transport and the transport did not work. Surfaced separately because the
 * remedy is operational rather than a change to the request — a PM who sees this
 * should be offered a resend, not a corrected email address.
 */
export class InvitationDeliveryError extends HttpError {
	constructor() {
		super(
			502,
			"INVITATION_DELIVERY_FAILED",
			"The invitation could not be emailed. Please try again.",
		);
	}
}

/**
 * Maps a stored status to the error a recipient gets for it.
 *
 * The four terminal-ish states a pending row can be in, each with the code the
 * frontend branches on. Returns null for PENDING, which is the only status that
 * can still be accepted.
 */
export function errorForStatus(
	status: InvitationStatus,
):
	| InvitationExpiredError
	| InvitationAlreadyAcceptedError
	| InvitationCanceledError
	| null {
	switch (status) {
		case "PENDING":
			return null;
		case "ACCEPTED":
			return new InvitationAlreadyAcceptedError();
		case "EXPIRED":
			return new InvitationExpiredError();
		case "CANCELED":
			return new InvitationCanceledError();
	}
}
