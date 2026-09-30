import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";

import {
	generateInvitationToken,
	hashInvitationToken,
	TOKEN_HASH_HEX_LENGTH,
} from "./invitation-token";

// ---------------------------------------------------------------------------
// The token, tested as a property rather than as a sequence.
//
// These are the guarantees the rest of the feature is built on, and each one is
// checked here rather than being assumed by the integration suite: the suite proves
// the flow works, these prove the flow could not work if the token were weak.
// ---------------------------------------------------------------------------

describe("invitation tokens", () => {
	test("are 256 bits of entropy, base64url encoded", () => {
		const token = generateInvitationToken();

		// 32 bytes in base64url is exactly 43 characters with no padding, and the
		// alphabet excludes anything a URL would have to escape. The route validates
		// this shape before touching the database, so it is a contract, not a
		// coincidence.
		expect(token).toHaveLength(43);
		expect(token).toMatch(/^[A-Za-z0-9_-]+$/);
	});

	test("never repeat", () => {
		const seen = new Set<string>();
		for (let i = 0; i < 5_000; i += 1) {
			seen.add(generateInvitationToken());
		}
		expect(seen.size).toBe(5_000);
	});

	test("hash to fixed-width lowercase hex, whatever the input", () => {
		const hash = hashInvitationToken(generateInvitationToken());

		expect(hash).toHaveLength(TOKEN_HASH_HEX_LENGTH);
		expect(hash).toMatch(/^[0-9a-f]{64}$/);
		// Deterministic, which is what makes the accept-path lookup an indexed
		// equality rather than a comparison.
		expect(hashInvitationToken("same")).toBe(hashInvitationToken("same"));
	});

	test("hash to the same value as a plain SHA-256 of the token", () => {
		// Pins the storage format against the obvious implementation. If the column
		// were ever re-hashed differently, this is the assertion that notices.
		const token = "a".repeat(43);
		expect(hashInvitationToken(token)).toBe(
			createHash("sha256").update(token, "utf8").digest("hex"),
		);
	});

	test("are not recoverable from the hash", () => {
		const token = generateInvitationToken();
		const hash = hashInvitationToken(token);

		// The point of the whole design: a dump of `project_invitations` must not be
		// a list of working acceptance links.
		expect(hash).not.toContain(token);
		expect(hash).not.toContain(token.slice(0, 8));
		expect(Buffer.from(hash, "hex").toString("base64url")).not.toBe(token);
	});

	test("a one-character difference changes the whole hash", () => {
		const a = generateInvitationToken();
		const b = `${a.slice(0, 42)}${a[42] === "A" ? "B" : "A"}`;

		expect(hashInvitationToken(a)).not.toBe(hashInvitationToken(b));
	});

	test("a branded token and the same plain string hash identically", () => {
		// The create path passes a branded token and the accept path passes whatever
		// arrived in the URL. If those two produced different digests, every
		// acceptance would 404 and the suite would only find out at runtime.
		const token = generateInvitationToken();
		expect(hashInvitationToken(token)).toBe(hashInvitationToken(String(token)));
	});
});
