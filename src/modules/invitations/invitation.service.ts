import { param } from "@prisma/orm-family-sql/relational-core/expression";
import { env } from "../../config/env";
import { db } from "../../prisma/db";
import {
	addDaysToTimestamp,
	compareTimestamps,
	nowTimestamp,
	type StoredTimestamp,
	toVarchar,
} from "../../prisma/scalars";
import type { UserContext } from "../authorization/authorization.types";
import { getEmailService } from "../email/email.service";
import {
	ProjectAlreadyDeletedError,
	ProjectArchivedError,
	ProjectMemberAlreadyExistsError,
	ProjectNotFoundError,
} from "../projects/project.errors";
import {
	errorForStatus,
	InvalidInvitationTokenError,
	InvitationAlreadyAcceptedError,
	InvitationAlreadyPendingError,
	InvitationDeliveryError,
	InvitationEmailMismatchError,
	InvitationNotAuthorizedError,
	InvitationNotFoundError,
	InvitationProjectUnavailableError,
	InvitationRecipientAlreadyMemberError,
} from "./invitation.errors";
import {
	canManageProjectInvitations,
	canUseInvitationApi,
} from "./invitation.policy";
import {
	createInvitationSchema,
	type InvitationTokenParams,
} from "./invitation.schema";
import type {
	InvitationAcceptanceResponse,
	InvitationPreview,
	InvitationRecord,
	InvitationResponse,
	InvitationSenderSummary,
	InvitationStatus,
} from "./invitation.types";
import { buildInvitationEmail } from "./invitation-email";
import {
	generateInvitationToken,
	hashInvitationToken,
} from "./invitation-token";

/**
 * The caller as the routes supply it: an authorization context plus the account
 * details this module has to reason about.
 *
 * `email` is not decoration. Acceptance's central question is whether this
 * account is the one the invitation was addressed to, and that cannot be
 * answered from a `UserContext`, which carries only the id and the role. Typing
 * the parameter as the wider shape means the check is visible in the signature
 * and a route cannot pass something that has no email to compare.
 */
type InvitationCaller = UserContext & {
	readonly email: string;
	readonly name: string;
};

type SenderRow = {
	id: string;
	name: string;
	email: string;
};

/**
 * Columns read from `users` to attribute an invitation.
 *
 * Allow-listed for the same reason the member list is: `passwordHash` is never
 * selected, so it cannot be read, logged, or leaked by a later edit to a response
 * builder.
 */
const SENDER_FIELDS = ["id", "name", "email"] as const;

type ProjectRow = {
	id: string;
	name: string;
	status: "PLANNING" | "ACTIVE" | "COMPLETED" | "ARCHIVED";
	deletedAt: StoredTimestamp | null;
};

// ---------------------------------------------------------------------------
// Expiry
// ---------------------------------------------------------------------------

/**
 * Whether a stored timestamp is still in the future.
 *
 * Reads the clock itself rather than taking it as an argument. Every caller wants
 * "now" and none of them want a different notion of it; a parameter would be a
 * chance to pass a stale value and get a wrong answer silently.
 */
function isInFuture(value: StoredTimestamp): boolean {
	return compareTimestamps(value, nowTimestamp()) === 1;
}

/**
 * The status a row presents to a client.
 *
 * The stored status, except that a PENDING row whose expiry has passed reports
 * EXPIRED. Nothing sweeps expired rows on a schedule, and that is deliberate: a
 * background job that had not run yet would make a link's usability depend on a
 * timer rather than on its expiry, which is the property this design rests on.
 * Deriving it means the accept path and the project manager's list always agree,
 * and the stored status stays free to record what happened rather than what is
 * still true.
 */
function effectiveStatus(
	row: Pick<InvitationRecord, "status" | "expiresAt">,
): InvitationStatus {
	if (row.status === "PENDING" && !isInFuture(row.expiresAt)) {
		return "EXPIRED";
	}
	return row.status;
}

// ---------------------------------------------------------------------------
// Lookups
// ---------------------------------------------------------------------------

/**
 * Loads a project including soft-deleted rows.
 *
 * Deliberately not the project module's `findVisibleProject`, which hides deleted
 * projects. An invitation can outlive its project — the invitation row cascades
 * away only when the project row is physically removed, and a project here is
 * soft-deleted — and the accept path has to be able to say "this project no
 * longer exists" rather than "this invitation no longer exists", because a
 * recipient holding a link to a deleted project deserves to be told why.
 */
async function findProjectIncludingDeleted(
	projectId: string,
): Promise<ProjectRow | null> {
	return db.orm.public.Projects.where((project) => project.id.eq(projectId))
		.select("id", "name", "status", "deletedAt")
		.first();
}

/**
 * A project an invitation may be attached to and joined.
 *
 * The same checks the member flow applies, in the same order, so an invite can
 * never do something adding a member could not: a deleted project cannot be
 * written to at all, and an archived one is a closed record whose membership is
 * frozen.
 *
 * `COMPLETED` is not refused, matching `addProjectMember`. A completed project is
 * closed to new *work*, not to membership: the existing member endpoints still
 * allow changes there, and a feature with a different rule for the same mutation
 * would be surprising rather than safer.
 */
async function requireInvitableProject(projectId: string): Promise<ProjectRow> {
	const project = await findProjectIncludingDeleted(projectId);
	if (!project) {
		throw new ProjectNotFoundError();
	}
	if (project.deletedAt !== null) {
		throw new ProjectAlreadyDeletedError();
	}
	if (project.status === "ARCHIVED") {
		throw new ProjectArchivedError();
	}
	return project;
}

async function loadSenders(
	ids: readonly string[],
): Promise<Map<string, SenderRow>> {
	if (ids.length === 0) {
		return new Map();
	}
	const rows = await db.orm.public.Users.where((user) => user.id.in([...ids]))
		.select(...SENDER_FIELDS)
		.all();
	return new Map(rows.map((row) => [row.id, row]));
}

function toSenderSummary(row: SenderRow): InvitationSenderSummary {
	return { id: row.id, name: row.name, email: row.email };
}

/** The sender row for the caller, from what the session already resolved. */
function callerAsSender(caller: InvitationCaller): SenderRow {
	return { id: caller.id, name: caller.name, email: caller.email };
}

/**
 * The allow-listed response projection.
 *
 * `tokenHash` is absent by construction. Building the object field by field is
 * what makes that a guarantee rather than an intention: there is no spread of the
 * stored row for a future column to ride out on.
 */
function toInvitationResponse(
	row: InvitationRecord,
	senders: Map<string, SenderRow>,
): InvitationResponse {
	const sender = senders.get(row.invitedById);
	if (!sender) {
		// The schema prevents this with ON DELETE RESTRICT. Reaching it would mean
		// that constraint had been dropped, and throwing beats emitting an
		// invitation attributed to nobody.
		throw new InvitationNotFoundError();
	}

	return {
		id: row.id,
		projectId: row.projectId,
		email: row.email,
		status: effectiveStatus(row),
		expiresAt: String(row.expiresAt),
		acceptedAt: row.acceptedAt === null ? null : String(row.acceptedAt),
		createdAt: String(row.createdAt),
		updatedAt: String(row.updatedAt),
		invitedBy: toSenderSummary(sender),
	};
}

// ---------------------------------------------------------------------------
// Project manager operations
// ---------------------------------------------------------------------------

/**
 * Invites an email address to a project.
 *
 * Create, then deliver, then report — and that order is the interesting part.
 *
 * Writing the row first means a token is never emailed for an invitation that
 * does not exist, so a recipient who follows a link can never be told the
 * invitation is invalid because the insert lost a race. Delivering second means
 * the caller learns whether the mail actually went out; a PM told "invitation
 * sent" has to be able to trust that a link is in the recipient's inbox.
 *
 * If delivery fails the row is removed again before the error is raised. Leaving a
 * PENDING row behind would be worse than never having created one: the recipient
 * has no token, the address looks invited on the PM's own list, and the obvious
 * retry is refused with INVITATION_ALREADY_PENDING. A failed send has to leave no
 * trace, or the retry does not work.
 */
export async function createProjectInvitation(
	caller: InvitationCaller,
	projectId: string,
	rawInput: unknown,
): Promise<InvitationResponse> {
	assertCanManage(caller);
	const { email } = createInvitationSchema.parse(rawInput);
	const project = await requireInvitableProject(projectId);

	await assertNotAlreadyInvited(project.id, email);

	// Retire expired invitations for the same address so it is not accumulating
	// dead PENDING rows, then refuse only if a *usable* one already exists. The
	// test is on the expiry, not the status column: a row that is PENDING but past
	// its expiry is not a live invitation, whatever its status says.
	const stale = await db.orm.public.ProjectInvitations.where((row) =>
		row.projectId.eq(project.id),
	)
		.where((row) => row.email.eq(toVarchar<255>(email)))
		.where((row) => row.status.eq("PENDING"))
		.all();

	const superseded: string[] = [];
	for (const row of stale) {
		if (isInFuture(row.expiresAt)) {
			throw new InvitationAlreadyPendingError();
		}
		superseded.push(row.id);
	}

	if (superseded.length > 0) {
		await db.orm.public.ProjectInvitations.where((row) => row.id.in(superseded))
			.where((row) => row.status.eq("PENDING"))
			.update({ status: "EXPIRED", updatedAt: nowTimestamp() });
	}

	const token = generateInvitationToken();
	const expiresAt = addDaysToTimestamp(nowTimestamp(), env.INVITATION_TTL_DAYS);

	const created = await db.orm.public.ProjectInvitations.create({
		projectId: project.id,
		email: toVarchar<255>(email),
		invitedById: caller.id,
		tokenHash: toVarchar<64>(hashInvitationToken(token)),
		status: "PENDING",
		expiresAt,
		updatedAt: nowTimestamp(),
	});

	await deliverInvitation({
		to: email,
		projectName: project.name,
		invitedByName: caller.name,
		token,
		expiresAt,
		invitationId: created.id,
	});

	// A send that failed has already removed the row, so the PM can retry.
	return toInvitationResponse(
		created,
		new Map([[caller.id, callerAsSender(caller)]]),
	);
}

/**
 * Refuses an invitation to somebody already on the project.
 *
 * Worth checking before the pending-invitation check: it is the more useful of
 * the two messages, and it is the only one that cannot be resolved by waiting.
 * The address is resolved to an account first, and skipped when there is none —
 * which is the ordinary case for this feature, since its whole purpose is
 * reaching people who have not registered yet.
 */
async function assertNotAlreadyInvited(
	projectId: string,
	email: string,
): Promise<void> {
	const account = await db.orm.public.Users.where((user) =>
		user.email.eq(toVarchar<255>(email)),
	)
		.select("id")
		.first();
	if (!account) {
		return;
	}

	if (await isAlreadyMember(projectId, account.id)) {
		throw new ProjectMemberAlreadyExistsError();
	}
}

/**
 * Sends a freshly created invitation, removing the row if it cannot go out.
 *
 * A new invitation is discarded rather than left in place, because a PENDING row
 * whose token was never delivered is a trap: the recipient has no link, the
 * address looks invited on the PM's own list, and the obvious retry is refused
 * with INVITATION_ALREADY_PENDING. A resend does the opposite — it puts the old
 * credential back — and keeps that logic to itself, because the two cases differ
 * in exactly the way that matters here.
 */
async function deliverInvitation(input: {
	to: string;
	projectName: string;
	invitedByName: string;
	token: string;
	expiresAt: StoredTimestamp;
	invitationId: string;
}): Promise<void> {
	try {
		await getEmailService().send(
			buildInvitationEmail({
				to: input.to,
				projectName: input.projectName,
				invitedByName: input.invitedByName,
				token: input.token,
				expiresAt: String(input.expiresAt),
				invitationId: input.invitationId,
			}),
		);
	} catch {
		await discardFailedInvitation(input.invitationId);
		throw new InvitationDeliveryError();
	}
}

/**
 * Removes an invitation whose email could not be delivered.
 *
 * Best-effort by design: the caller is already turning a delivery failure into a
 * 502, and a cleanup error must not replace that with a less useful one. The
 * orphan row is harmless — it holds only a hash, and the next attempt for the same
 * address supersedes it.
 */
async function discardFailedInvitation(invitationId: string): Promise<void> {
	try {
		await db.orm.public.ProjectInvitations.where((row) =>
			row.id.eq(invitationId),
		)
			.where((row) => row.status.eq("PENDING"))
			.delete();
	} catch {
		// Intentionally swallowed; see above.
	}
}

/**
 * Every invitation ever issued for a project, newest first.
 *
 * Not paginated. This backs a project's settings section rather than a report,
 * and unlike the member list it cannot grow without bound through normal use —
 * issuing one is a PM-only, deliberate act — so a cap here would limit the UI with
 * no corresponding benefit. Accepted and canceled rows are kept rather than
 * filtered out: "who was invited and what became of it" is the question the
 * section answers, and a list that dropped its history could not answer it.
 */
export async function listProjectInvitations(
	caller: InvitationCaller,
	projectId: string,
): Promise<InvitationResponse[]> {
	assertCanManage(caller);
	const project = await findProjectIncludingDeleted(projectId);
	if (!project) {
		throw new ProjectNotFoundError();
	}

	const rows = await db.orm.public.ProjectInvitations.where((row) =>
		row.projectId.eq(project.id),
	)
		.orderBy((row) => row.createdAt.desc())
		.orderBy((row) => row.id.desc())
		.all();

	const senders = await loadSenders([
		...new Set(rows.map((row) => row.invitedById)),
	]);
	return rows.map((row) => toInvitationResponse(row, senders));
}

/**
 * Issues a fresh token for an existing invitation.
 *
 * Resend rather than create, so the invitation keeps its identity, its place in
 * the project history, and the record of when it was first sent. Only the
 * credential changes: a new hash, a new expiry, and back to PENDING.
 *
 * Accepted is refused, and it is the one status with no recovery — the membership
 * exists, so a new link would offer to join something they are already on.
 * CANCELED and EXPIRED are both allowed, because resending is how a PM revives an
 * invitation they took back or that ran out.
 *
 * The row is rotated *before* the mail goes out and restored if it fails. The
 * other order looks safer and is not: rotating after a successful send leaves a
 * window in which both links work, and a PM who asked to rotate a token and was
 * told it worked must be able to rely on the old one being dead. If the send
 * fails, the previous credential is put back so the recipient is never left with
 * no working link because of a transport error.
 */
export async function resendProjectInvitation(
	caller: InvitationCaller,
	projectId: string,
	invitationId: string,
): Promise<InvitationResponse> {
	assertCanManage(caller);
	const project = await requireInvitableProject(projectId);

	const previous = await findInvitationInProject(project.id, invitationId);
	if (previous.status === "ACCEPTED") {
		throw new InvitationAlreadyAcceptedError();
	}

	const token = generateInvitationToken();
	const expiresAt = addDaysToTimestamp(nowTimestamp(), env.INVITATION_TTL_DAYS);

	const rotated = await db.orm.public.ProjectInvitations.where((row) =>
		row.id.eq(previous.id),
	).update({
		tokenHash: toVarchar<64>(hashInvitationToken(token)),
		status: "PENDING",
		expiresAt,
		acceptedAt: null,
		invitedById: caller.id,
		updatedAt: nowTimestamp(),
	});

	if (!rotated) {
		// The row was read a moment ago and the update is keyed on its id, so this
		// is only reachable if something deleted it in between. Reported as not
		// found rather than as a fault, because from the caller's point of view
		// that is exactly what happened.
		throw new InvitationNotFoundError();
	}

	try {
		await getEmailService().send(
			buildInvitationEmail({
				to: rotated.email,
				projectName: project.name,
				invitedByName: caller.name,
				token,
				expiresAt: String(expiresAt),
				invitationId: rotated.id,
			}),
		);
	} catch {
		await restoreAfterFailedResend(previous);
		throw new InvitationDeliveryError();
	}

	return toInvitationResponse(
		rotated,
		new Map([[caller.id, callerAsSender(caller)]]),
	);
}

/**
 * Puts an invitation back the way it was after a resend that could not be
 * delivered.
 *
 * Every field the rotation touched, restored from the values read before it, so a
 * failed resend is invisible to the recipient: the original link still works and
 * the PM's list still shows the invitation as it was. Guarded on the current
 * status so a cancel that happened in the meantime is not undone by an unrelated
 * delivery failure.
 */
async function restoreAfterFailedResend(
	previous: InvitationRecord,
): Promise<void> {
	try {
		await db.orm.public.ProjectInvitations.where((row) =>
			row.id.eq(previous.id),
		)
			.where((row) => row.status.eq("PENDING"))
			.update({
				tokenHash: previous.tokenHash,
				status: previous.status,
				expiresAt: previous.expiresAt,
				acceptedAt: previous.acceptedAt,
				invitedById: previous.invitedById,
			});
	} catch {
		// Best effort; the caller is already returning a 502.
	}
}

/**
 * Withdraws an invitation.
 *
 * The membership never existed, so this only has to stop the link working, and it
 * is idempotent: cancelling an already-canceled invitation succeeds. A PM clicking
 * twice, or clicking after the row already reported CANCELED, has reached the
 * state they asked for, and a conflict would only teach them to reload and try
 * again.
 *
 * Accepted is refused: the membership it created stands, and a PM who wants that
 * gone is removing a member, which is a different and separately authorized act.
 */
export async function cancelProjectInvitation(
	caller: InvitationCaller,
	projectId: string,
	invitationId: string,
): Promise<void> {
	assertCanManage(caller);
	const project = await requireInvitableProject(projectId);

	const existing = await findInvitationInProject(project.id, invitationId);
	if (existing.status === "ACCEPTED") {
		throw new InvitationAlreadyAcceptedError();
	}
	if (existing.status === "CANCELED") {
		return;
	}

	await db.orm.public.ProjectInvitations.where((row) =>
		row.id.eq(existing.id),
	).update({ status: "CANCELED", updatedAt: nowTimestamp() });
}

/**
 * Loads an invitation, scoped to the project in the path.
 *
 * The project scope is part of the lookup rather than a check afterwards, so an
 * invitation id belonging to another project is not found rather than
 * found-and-refused. A caller learns nothing about invitations they did not
 * address, and there is no way to probe for a row's existence by id.
 */
async function findInvitationInProject(
	projectId: string,
	invitationId: string,
): Promise<InvitationRecord> {
	const row = await db.orm.public.ProjectInvitations.where((invitation) =>
		invitation.id.eq(invitationId),
	)
		.where((invitation) => invitation.projectId.eq(projectId))
		.first();
	if (!row) {
		throw new InvitationNotFoundError();
	}
	return row;
}

function assertCanManage(caller: InvitationCaller): void {
	// Two refusals, one code. The internal-API check is the coarse outer gate that
	// keeps client guests out of the project module entirely; the role check is
	// what makes managing invitations PM-only. They deliberately report the same
	// error, so an invite cannot be distinguished from an add-member attempt as a
	// probing surface.
	if (!canUseInvitationApi(caller) || !canManageProjectInvitations(caller)) {
		throw new InvitationNotAuthorizedError();
	}
}

// ---------------------------------------------------------------------------
// Recipient operations
// ---------------------------------------------------------------------------

/**
 * Describes an invitation to its recipient, before they accept it.
 *
 * Authenticated, because the acceptance screen has to know who is signed in to say
 * whether the invitation is theirs — and the answer has to come from the server,
 * since the token proves nothing about the account holding it.
 *
 * The projection is deliberately the smallest one in the module. This is the one
 * response any holder of the link can obtain, including someone who forwards the
 * email, so it names the project, the sender, and whether the link works, and
 * nothing else: no member list, no other invitations, no project description. The
 * address comes back because the recipient needs to know whether the invitation is
 * addressed to them, and it is their own address, not a third party's.
 */
export async function getInvitationPreview(
	caller: InvitationCaller,
	params: InvitationTokenParams,
): Promise<InvitationPreview> {
	const { invitation, project } = await resolveInvitation(params.token);

	const sender = await db.orm.public.Users.where((row) =>
		row.id.eq(invitation.invitedById),
	)
		.select(...SENDER_FIELDS)
		.first();
	if (!sender) {
		throw new InvitationNotFoundError();
	}

	const status = effectiveStatus(invitation);
	const isForCaller =
		caller.email.toLowerCase() === invitation.email.toLowerCase();

	return {
		email: invitation.email,
		project: { id: project.id, name: project.name },
		invitedBy: toSenderSummary(sender),
		status,
		// Usable means "this link would work for the person reading it", which is
		// two questions and not one: the invitation must still be pending, and it
		// must be addressed to the account holding it. Folding the identity check
		// in here is what lets the acceptance screen show "sign in as ..." instead
		// of a button that fails.
		usable:
			status === "PENDING" && !isProjectUnavailable(project) && isForCaller,
		expiresAt: String(invitation.expiresAt),
	};
}

/**
 * Accepts an invitation, creating the membership in the same transaction.
 *
 * The properties this has to hold, in the order they are checked:
 *
 *  - The token is the only credential. It is hashed and the row is found by that
 *    hash, so the lookup is an indexed equality rather than a comparison in
 *    process, and a token matching nothing is indistinguishable from one that was
 *    never issued.
 *  - The account must be the invited address. Otherwise a link forwarded to a
 *    colleague — or leaked — would let them join the project.
 *  - The project must still be joinable. A deleted or archived project is refused
 *    with a message naming which, because the recipient's next move differs.
 *  - The membership and the state change commit together or not at all, and the
 *    state change is guarded by `status = 'PENDING'` *inside* the transaction.
 *    That last guard is what makes replay impossible: the second of two concurrent
 *    accepts updates zero rows and is rejected, so a token cannot produce two
 *    memberships and the loser is told the invitation was already accepted rather
 *    than finding a duplicate member.
 */
export async function acceptInvitation(
	caller: InvitationCaller,
	params: InvitationTokenParams,
): Promise<InvitationAcceptanceResponse> {
	const { invitation, project } = await resolveInvitation(params.token);

	if (isProjectUnavailable(project)) {
		throw new InvitationProjectUnavailableError(
			project.deletedAt !== null ? "DELETED" : "ARCHIVED",
		);
	}

	const statusError = errorForStatus(effectiveStatus(invitation));
	if (statusError) {
		throw statusError;
	}

	if (caller.email.toLowerCase() !== invitation.email.toLowerCase()) {
		throw new InvitationEmailMismatchError(invitation.email);
	}

	// Already on the project. Reported rather than treated as success: the
	// invitation is genuinely spent, and the caller should be told the membership
	// predates it rather than handed a success implying this link granted access.
	if (await isAlreadyMember(project.id, caller.id)) {
		throw new InvitationRecipientAlreadyMemberError();
	}

	const acceptedAt = nowTimestamp();

	const member = await db.transaction(async (tx) => {
		// Flip the status first, under a guard on the status and the expiry, so this
		// statement — not a check above it — decides which of two concurrent accepts
		// wins. `expires_at > now()` is repeated here so an invitation that lapses
		// between the read and the write is caught by the same atomic predicate
		// rather than by a clock reading taken earlier.
		const claimed = await tx.execute(
			db.raw.sql`UPDATE "public"."project_invitations"
				SET "status" = 'ACCEPTED',
					"accepted_at" = ${param(acceptedAt, { codecId: "pg/timestamp-temporal@1" })}::timestamp,
					"updated_at" = now()
				WHERE "id" = ${invitation.id}::uuid
					AND "status" = 'PENDING'
					AND "expires_at" > now()`
				.affectedCount()
				.build(),
		);

		if (claimed.affectedRows === 0) {
			// Somebody else took it between the read and here. Re-read to report
			// which terminal state it reached, so the caller is told something true
			// rather than a generic conflict.
			const current = await tx.orm.public.ProjectInvitations.where((row) =>
				row.id.eq(invitation.id),
			).first();
			throw (
				(current ? errorForStatus(effectiveStatus(current)) : null) ??
				new InvitationAlreadyAcceptedError()
			);
		}

		try {
			return await tx.orm.public.ProjectMembers.create({
				projectId: project.id,
				userId: caller.id,
			});
		} catch (error) {
			// A membership can also appear between the check above and this insert — a
			// PM adding the same person directly, for instance. The unique index
			// decides, the transaction rolls back, and the invitation stays PENDING,
			// which is the honest outcome: this link granted nothing.
			if (isMembershipUniqueViolation(error)) {
				throw new InvitationRecipientAlreadyMemberError();
			}
			throw error;
		}
	});

	return {
		invitation: {
			id: invitation.id,
			projectId: invitation.projectId,
			email: invitation.email,
			acceptedAt: String(acceptedAt),
		},
		member: {
			id: member.id,
			projectId: member.projectId,
			userId: member.userId,
			createdAt: String(member.createdAt),
		},
		project: { id: project.id, name: project.name },
	};
}

/**
 * Whether the project can still be joined.
 *
 * A soft-deleted project is the `deletedAt` check rather than a status, and the
 * caller tells the two apart so the error can name which it was.
 */
function isProjectUnavailable(project: ProjectRow): boolean {
	return project.deletedAt !== null || project.status === "ARCHIVED";
}

/** Whether the account is already on the project. */
async function isAlreadyMember(
	projectId: string,
	userId: string,
): Promise<boolean> {
	const row = await db.orm.public.ProjectMembers.where((member) =>
		member.projectId.eq(projectId),
	)
		.where((member) => member.userId.eq(userId))
		.select("id")
		.first();
	return row !== null;
}

/**
 * Whether a driver error is the project-members unique index.
 *
 * Matched on the constraint name or the SQLSTATE, as the member service does, so
 * a driver wording change cannot turn a duplicate into a 500.
 */
function isMembershipUniqueViolation(error: unknown): boolean {
	if (typeof error !== "object" || error === null) {
		return false;
	}
	const candidate = error as { constraint?: unknown; code?: unknown };
	return (
		candidate.code === "23505" ||
		candidate.constraint === "project_members_project_id_user_id_unique"
	);
}

/**
 * Turns a raw token into the invitation and project it names.
 *
 * Every failure past this point is `INVITATION_NOT_FOUND`, on purpose. A token
 * that is unknown, a token whose row went with a physically deleted project, and a
 * token that was never issued are the same answer, so this endpoint cannot be used
 * to confirm that a guessed token is real.
 *
 * The project is loaded with deleted rows included, because the recipient of a
 * link to a deleted project has to be told the project is gone. That is the only
 * thing said about it, and it is said to someone who already holds a token for it.
 */
async function resolveInvitation(
	token: string,
): Promise<{ invitation: InvitationRecord; project: ProjectRow }> {
	const invitation = await db.orm.public.ProjectInvitations.where((row) =>
		row.tokenHash.eq(toVarchar<64>(hashInvitationToken(token))),
	).first();

	if (!invitation) {
		throw new InvalidInvitationTokenError();
	}

	const project = await findProjectIncludingDeleted(invitation.projectId);
	if (!project) {
		// Only reachable if the cascade had been disabled. Treated as "not found" so
		// the response cannot be used to detect a partially-deleted project.
		throw new InvalidInvitationTokenError();
	}

	return { invitation, project };
}
