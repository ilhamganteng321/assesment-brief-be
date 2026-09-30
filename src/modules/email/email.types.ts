/**
 * The email surface the product depends on.
 *
 * A single `send` that takes a prepared message, rather than an interface with a
 * method per transactional email. The invitation flow composes its own subject and
 * body because that content is product copy that changes with the design, and a
 * provider-shaped API (attachments, templates, batching) would push that copy
 * through an abstraction that exists to isolate the transport instead.
 *
 * Two implementations exist — a real SMTP one and the in-memory one used by tests
 * and local development — and nothing outside this module knows which is in play.
 */
export type EmailMessage = {
	/** Envelope recipient. The address the invitation is addressed to. */
	to: string;
	subject: string;
	/** Plain text body. Rendered first because it is the one that must not break. */
	text: string;
	/** Optional HTML alternative for clients that prefer it. */
	html?: string;
	/**
	 * Correlation for the log, never shown to the recipient.
	 *
	 * Present so an operator reading logs can tie a delivery failure to the
	 * invitation that caused it without the message itself carrying a token.
	 */
	correlationId?: string;
};

export type SendResult = {
	/** Provider's own identifier, when it gives one, for support and delivery logs. */
	providerMessageId?: string;
};

export interface EmailService {
	/**
	 * Delivers a message, or throws.
	 *
	 * Failures are not swallowed into a result. A caller that cannot tell whether
	 * the mail went out cannot decide what to tell the user or whether to offer a
	 * resend, so a failure has to be an exception it is forced to handle.
	 */
	send(message: EmailMessage): Promise<SendResult>;
}
