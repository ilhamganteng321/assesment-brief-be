import { describe, expect, test } from "bun:test";
import {
	buildAcceptanceUrl,
	buildInvitationEmail,
} from "../invitations/invitation-email";
import { LogEmailService, MemoryEmailService } from "./email.providers";
import type { EmailMessage } from "./email.types";

// ---------------------------------------------------------------------------
// The two transport implementations, and the copy they carry.
//
// The providers are trivial; what is worth pinning is the behaviour the invitation
// service depends on. A `send` that resolves on failure would let a PM be told an
// invitation was sent when no mail left the building, which is the failure this
// abstraction exists to make impossible.
// ---------------------------------------------------------------------------

const MESSAGE: EmailMessage = {
	to: "recipient@example.com",
	subject: "Subject",
	text: "Body",
	correlationId: "invitation:abc",
};

describe("MemoryEmailService", () => {
	test("records what it was given and returns a provider id", async () => {
		const service = new MemoryEmailService();

		const result = await service.send(MESSAGE);

		expect(service.messages()).toEqual([MESSAGE]);
		expect(result.providerMessageId).toBe("memory-1");
	});

	test("matches a recipient case-insensitively, as an address must", async () => {
		const service = new MemoryEmailService();
		await service.send(MESSAGE);

		// The address in a delivered message is normalized before it gets here, but a
		// test double that could not find it again would make every suite that reads
		// the token fail for a reason that has nothing to do with the code under test.
		expect(service.lastTo("  RECIPIENT@Example.com ")).toEqual(MESSAGE);
	});

	test("returns the most recent message to an address", async () => {
		const service = new MemoryEmailService();
		await service.send({ ...MESSAGE, subject: "First" });
		await service.send({ ...MESSAGE, subject: "Second" });

		expect(service.lastTo(MESSAGE.to)?.subject).toBe("Second");
	});

	test("drops the oldest message past its capacity rather than growing", async () => {
		const service = new MemoryEmailService(2);
		await service.send({ ...MESSAGE, subject: "First" });
		await service.send({ ...MESSAGE, subject: "Second" });
		await service.send({ ...MESSAGE, subject: "Third" });

		expect(service.messages().map((m) => m.subject)).toEqual([
			"Second",
			"Third",
		]);
	});

	test("clear empties it, so one suite cannot read another's mail", async () => {
		const service = new MemoryEmailService();
		await service.send(MESSAGE);

		service.clear();

		expect(service.messages()).toHaveLength(0);
	});
});

describe("LogEmailService", () => {
	test("prints the whole message, link included", async () => {
		// The disclosure is the point. A developer following the invitation flow has
		// no mailbox, and it is confined to non-production by the EMAIL_PROVIDER check
		// in the env schema, which refuses to boot production with this provider.
		const lines: string[] = [];
		const service = new LogEmailService({
			info: (line: string) => lines.push(line),
		} as unknown as Pick<Console, "info">);

		await service.send(MESSAGE);

		const output = lines.join("\n");
		expect(output).toContain("recipient@example.com");
		expect(output).toContain("Body");
		expect(output).toContain("invitation:abc");
	});
});

describe("the invitation email", () => {
	const input = {
		to: "recipient@example.com",
		projectName: "Apollo",
		invitedByName: "Ada Lovelace",
		token: "t".repeat(43),
		expiresAt: "2026-10-07T06:00:00.000",
		invitationId: "11111111-1111-4111-8111-111111111111",
	};

	test("carries the acceptance link in both bodies", () => {
		const message = buildInvitationEmail(input);
		const link = `/invitations/accept?token=${input.token}`;

		// Plain text first because it is the one that must not break, and the HTML
		// alternative because a client that renders it should be able to click.
		expect(message.text).toContain(link);
		expect(message.html).toContain(link);
		expect(message.to).toBe(input.to);
		expect(message.subject).toContain("Apollo");
	});

	test("names the project, the sender, the expiry and the single address", () => {
		const message = buildInvitationEmail(input);

		expect(message.text).toContain("Apollo");
		expect(message.text).toContain("Ada Lovelace");
		expect(message.text).toContain("2026-10-07");
		expect(message.text).toContain("can only be used by recipient@example.com");
	});

	test("correlates on the invitation id and never on the token", () => {
		const message = buildInvitationEmail(input);

		// The log line has to tie a delivery failure back to the row that caused it.
		// If the correlation id carried the token, every log sink would hold a live
		// acceptance link.
		expect(message.correlationId).toBe(`invitation:${input.invitationId}`);
		expect(message.correlationId).not.toContain(input.token);
	});

	test("escapes interpolated text in the HTML body", () => {
		const message = buildInvitationEmail({
			...input,
			projectName: '"><script>alert(1)</script>',
			invitedByName: "O'Brien & <b>",
		});

		// The project name is free text a PM typed. Interpolated raw it would put
		// script into a colleague's mail client, which is a stored-XSS surface aimed
		// at exactly the people who run the projects.
		expect(message.html).not.toContain("<script>");
		expect(message.html).toContain("&lt;script&gt;");
		expect(message.html).toContain("O&#39;Brien &amp; &lt;b&gt;");
		// The text body is not HTML, so it is left alone: escaping it there would
		// show the reader `&amp;` where they asked for `&`.
		expect(message.text).toContain("O'Brien & <b>");
	});

	test("falls back to the raw expiry rather than failing the send", () => {
		const message = buildInvitationEmail({
			...input,
			expiresAt: "not a date",
		});

		// A mail that says "expires on a slightly odd date" beats a failed send that
		// leaves a PM believing nothing was sent.
		expect(message.text).toContain("not a date");
	});

	test("builds the link from FRONTEND_URL, not the API base", () => {
		const url = buildAcceptanceUrl("abc");

		// The token is consumed by the browser application. Pointing this at the API
		// would hand the recipient a JSON response instead of a page.
		expect(url).toContain("/invitations/accept?token=abc");
		expect(url.startsWith("http")).toBe(true);
	});
});
