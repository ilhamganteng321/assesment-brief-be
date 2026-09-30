import { env } from "../../config/env";
import { LogEmailService, MemoryEmailService } from "./email.providers";
import type { EmailService } from "./email.types";

/**
 * The process-wide email service.
 *
 * Resolved from configuration on first use and injected wherever mail is sent, so
 * the invitation service never names a provider and the tests never have to stub
 * a module. A mutable holder rather than a bare constant: an integration test that
 * needs to read the delivered message has to be able to install the capturing
 * implementation, and passing it through every call site instead would mean the
 * production call sites and the test call sites were different code.
 *
 * Resolution is deferred rather than done at import so that a deployment which
 * sets `EMAIL_PROVIDER=smtp` can still boot far enough to register its transport
 * through `setEmailService` before anything tries to send.
 */
let current: EmailService | undefined;

function createFromConfig(): EmailService {
	switch (env.EMAIL_PROVIDER) {
		case "memory":
			return new MemoryEmailService();
		case "log":
			return new LogEmailService(console);
		case "smtp":
			// The only production-legal value, and deliberately not implemented here.
			// An SMTP client is a dependency this project has not taken, and shipping
			// a hand-rolled socket client to satisfy a configuration check would be
			// worse than the honest failure below: it names what the operator has to
			// do and refuses to pretend a message was delivered.
			throw new Error(
				"EMAIL_PROVIDER=smtp but no SMTP transport is registered. Call setEmailService() with a transport before the first send.",
			);
	}
}

export function getEmailService(): EmailService {
	current ??= createFromConfig();
	return current;
}

/**
 * Installs a different implementation for the rest of the process.
 *
 * Exported for tests and for a deployment that registers a real provider at
 * startup. Returns the previous service so a caller can restore it, which keeps
 * an override from leaking into a later test through module-level state.
 */
export function setEmailService(service: EmailService): () => void {
	const previous = current;
	current = service;
	return () => {
		current = previous;
	};
}
