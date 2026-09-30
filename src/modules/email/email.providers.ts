import type { EmailMessage, EmailService, SendResult } from "./email.types";

/**
 * Prints the message to the application log.
 *
 * The default outside production, and the reason it prints the body in full is
 * that the body contains the acceptance link: a developer working on the
 * invitation flow has to be able to follow the link without a mailbox, and
 * logging the recipient, subject and correlation id but not the link would leave
 * the flow untestable by hand. That is a deliberate disclosure and it is safe
 * only because this implementation is refused in production — see the
 * `EMAIL_PROVIDER` check in src/config/env.ts, which fails the boot rather than
 * falling back to here.
 *
 * It is the console and not a file so that nothing survives a restart to be
 * swept up by a log shipper, and it is the console because a log line is
 * already the thing an operator greps for when a delivery fails.
 */
export class LogEmailService implements EmailService {
	constructor(private readonly logger: Pick<Console, "info">) {}

	async send(message: EmailMessage): Promise<SendResult> {
		this.logger.info(
			[
				"[email] provider=log",
				`to=${message.to}`,
				`subject=${JSON.stringify(message.subject)}`,
				message.correlationId ? `correlationId=${message.correlationId}` : null,
				"---",
				message.text,
			]
				.filter((part) => part !== null)
				.join("\n"),
		);
		return {};
	}
}

/**
 * Keeps messages in memory instead of delivering them.
 *
 * The implementation the integration tests assert against: an invitation is only
 * meaningful if the token that was emailed is the token that was stored, and the
 * only honest way to prove that is to read the delivered message back. A test
 * that reached into the database and hashed a token it invented would pass even
 * if the wiring were reversed.
 *
 * A fixed cap keeps a long suite from growing without limit, dropping the oldest
 * message rather than failing: a lost early message cannot make a later
 * assertion pass that would otherwise fail.
 */
export class MemoryEmailService implements EmailService {
	private readonly sent: EmailMessage[] = [];

	constructor(private readonly capacity = 100) {}

	async send(message: EmailMessage): Promise<SendResult> {
		this.sent.push(message);
		if (this.sent.length > this.capacity) {
			this.sent.shift();
		}
		return { providerMessageId: `memory-${this.sent.length}` };
	}

	/** Every message delivered so far, oldest first. */
	messages(): readonly EmailMessage[] {
		return [...this.sent];
	}

	/** The most recent message addressed to `to`, or undefined. */
	lastTo(to: string): EmailMessage | undefined {
		const normalized = to.trim().toLowerCase();
		return [...this.sent]
			.reverse()
			.find((m) => m.to.trim().toLowerCase() === normalized);
	}

	clear(): void {
		this.sent.length = 0;
	}
}
