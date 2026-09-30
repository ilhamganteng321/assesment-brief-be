import type { Models } from "../../prisma/contract.d";

/** A stored invitation row, with its relations omitted. */
export type InvitationRecord = Omit<
	Models.public_ProjectInvitations,
	"project" | "invitedBy"
>;

/**
 * The four states an invitation can be in.
 *
 * Read from the contract rather than restated, so a fifth value added to the
 * enum is a type error here instead of a silently unhandled case in the accept
 * path.
 */
export type InvitationStatus = InvitationRecord["status"];

/**
 * An invitation as the API returns it.
 *
 * An allow-list projection for the same reason the project and member responses
 * are: database rows are never returned directly, so `tokenHash` cannot reach a
 * client by being selected, and a new column cannot leak without a decision
 * here. The recipient's address is included because a project manager has to be
 * able to see who was invited, and the address is what they typed.
 */
export type InvitationResponse = {
	id: string;
	projectId: string;
	email: string;
	status: InvitationStatus;
	expiresAt: string;
	acceptedAt: string | null;
	createdAt: string;
	updatedAt: string;
	invitedBy: InvitationSenderSummary;
};

/** Who sent the invitation. Same shape as the member summary, for the same reason. */
export type InvitationSenderSummary = {
	id: string;
	name: string;
	email: string;
};

/**
 * What acceptance returns.
 *
 * The membership, because the caller's next act is to open the project they were
 * just added to, and the project id is on it. A separate type from
 * `ProjectMemberResponse` rather than a reuse: the member routes return the full
 * nested user summary, whereas this path has no need to echo the account back to
 * the person who just logged in as it.
 */
export type InvitationAcceptanceResponse = {
	invitation: {
		id: string;
		projectId: string;
		email: string;
		acceptedAt: string | null;
	};
	member: {
		id: string;
		projectId: string;
		userId: string;
		createdAt: string;
	};
	project: {
		id: string;
		name: string;
	};
};

/**
 * A preview of an invitation for the acceptance screen.
 *
 * Shown before the recipient decides anything, so it is deliberately minimal:
 * the project name, who sent it, and whether the link still works. It exposes no
 * member list, no other invitations and no token state beyond "usable", because
 * this is reachable by anyone holding the link, including a recipient who has not
 * signed in yet and a forwarder of the email.
 */
export type InvitationPreview = {
	email: string;
	project: {
		id: string;
		name: string;
	};
	invitedBy: InvitationSenderSummary;
	status: InvitationStatus;
	/** True only when the invitation is PENDING and its expiry is still in the future. */
	usable: boolean;
	expiresAt: string;
};
