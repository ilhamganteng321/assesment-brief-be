import { env } from "../../config/env";
import { HttpError } from "../../lib/http-error";
import type { EmailMessage } from "../email/email.types";

/**
 * The acceptance link.
 *
 * Built from `FRONTEND_URL` rather than `API_BASE_URL`, because the token is
 * consumed by the browser application, not by this API. It lands on the
 * frontend's `/invitations/accept` page, which then posts the token to
 * `POST /invitations/:token/accept`.
 *
 * `FRONTEND_URL` is validated at boot to be a bare origin, so the result cannot
 * contain a path, a query or a fragment and appending one is safe.
 */
export function buildAcceptanceUrl(token: string): string {
	const frontendUrl = env.FRONTEND_URL;
	if (!frontendUrl) {
		// Not reachable in production, where the env schema requires the origin, and
		// in development it is set by .env. Raised as a server fault rather than
		// producing a relative link, because a link with no host would be emailed
		// and never work, and the sender would have no way to see why.
		throw new HttpError(
			500,
			"INVALID_CONFIG",
			"FRONTEND_URL must be configured to build an invitation link",
		);
	}
	return `${frontendUrl.replace(/\/+$/, "")}/invitations/accept?token=${encodeURIComponent(token)}`;
}

/**
 * The invitation email.
 *
 * Composed here rather than in the invitation service so that the product copy
 * for one transactional email has one home, and so the service reads as what it
 * is: a state machine plus a delivery call.
 *
 * The link appears in both the text and the HTML body. A recipient who reads
 * plain text is the common case and must not have to parse markup to act, and a
 * client that renders HTML must be able to click rather than copy. The token is
 * never mentioned separately from the URL, so there is no second copy of it in
 * the message to leak.
 */
export function buildInvitationEmail(input: {
	readonly to: string;
	readonly projectName: string;
	readonly invitedByName: string;
	readonly token: string;
	readonly expiresAt: string;
	readonly invitationId: string;
}): EmailMessage {
	const link = buildAcceptanceUrl(input.token);
	const expiresOn = formatExpiryForHumans(input.expiresAt);

	const text = [
		`${input.invitedByName} invited you to join the project "${input.projectName}".`,
		"",
		"Accept the invitation:",
		link,
		"",
		`This link expires on ${expiresOn}. It can only be used by ${input.to}, and only once.`,
		"",
		"If you were not expecting this invitation you can ignore this message; nothing has been added to the project.",
	].join("\n");

	return {
		to: input.to,
		subject: `You have been invited to join ${input.projectName}`,
		text,
		html: renderInvitationHtml({
			projectName: input.projectName,
			invitedByName: input.invitedByName,
			link,
			expiresOn,
			recipient: input.to,
		}),
		// The correlation id, never the token: a log line that ties a delivery
		// failure to the invitation that caused it, without writing the token out.
		correlationId: `invitation:${input.invitationId}`,
	};
}

/**
 * A date fit for a human, derived from the stored ISO value.
 *
 * The stored value is UTC; the recipient reads a date, not an instant, and a UTC
 * date is the only one that can be rendered without knowing their offset. Falls
 * back to the raw string rather than throwing, because a mail that says
 * "expires on a slightly odd date" is better than a failed send.
 */
function formatExpiryForHumans(isoTimestamp: string): string {
	const parsed = Date.parse(isoTimestamp);
	if (Number.isNaN(parsed)) {
		return isoTimestamp;
	}
	return new Date(parsed).toISOString().slice(0, 10);
}

/**
 * The HTML alternative.
 *
 * Inline styles only. An email is rendered by clients this project does not
 * control and cannot ship a stylesheet to, so a `<style>` block and a class are
 * both unreliable; the handful of rules that make the message readable are
 * written onto the elements.
 */
function renderInvitationHtml(input: {
	readonly projectName: string;
	readonly invitedByName: string;
	readonly link: string;
	readonly expiresOn: string;
	readonly recipient: string;
}): string {
	const linkStyle = [
		"display:inline-block",
		"padding:12px 20px",
		"background:#1f2937",
		"color:#ffffff",
		"text-decoration:none",
		"border-radius:6px",
		"font-weight:600",
	].join(";");

	return `<!doctype html>
<html>
	<body style="margin:0;padding:24px;background:#f3f4f6;font-family:Arial,Helvetica,sans-serif;color:#111827">
		<div style="max-width:560px;margin:0 auto;background:#ffffff;border-radius:8px;padding:32px">
			<h1 style="margin:0 0 16px;font-size:20px;line-height:1.4">Join ${escapeHtml(
				input.projectName,
			)}</h1>
			<p style="margin:0 0 16px;font-size:15px;line-height:1.6">
				${escapeHtml(input.invitedByName)} invited you to join this project.
			</p>
			<p style="margin:0 0 24px">
				<a href="${escapeHtml(input.link)}" style="${linkStyle}">Accept invitation</a>
			</p>
			<p style="margin:0 0 8px;font-size:13px;line-height:1.6;color:#4b5563">
				This link expires on ${escapeHtml(input.expiresOn)} and can only be used by
				${escapeHtml(input.recipient)}.
			</p>
			<p style="margin:0;font-size:13px;line-height:1.6;color:#6b7280">
				If you were not expecting this invitation you can ignore this message; nothing has
				been added to the project.
			</p>
		</div>
	</body>
</html>`;
}

/**
 * Escapes text interpolated into the HTML body.
 *
 * The project name and the inviter's name are user-controlled, and the project
 * name in particular is free text a PM typed. Interpolating it raw would let a
 * project named `"><script>` put script in a colleague's mail client, so every
 * interpolated value goes through here.
 */
function escapeHtml(value: string): string {
	return value
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;")
		.replace(/'/g, "&#39;");
}
