import { createHash, randomBytes } from "node:crypto";

/**
 * The token lives in the emailed link and nowhere else.
 *
 * The database stores `sha256(raw)`, so a dump of `project_invitations` yields
 * hashes that cannot be turned back into acceptance links. This row is the only
 * thing standing between an inbox compromise and project access, and hashing is
 * what makes a database disclosure useless for that.
 *
 * SHA-256 rather than bcrypt or argon2 is the correct primitive here, not a
 * shortcut. Password hashes exist to slow down guessing a low-entropy secret;
 * this secret is 256 bits from the CSPRNG, so there is no search to slow down
 * and a slow hash would only add latency to the accept path. What the hash has to
 * be is one-way and constant-cost, which SHA-256 is. No timing-safe comparison
 * is written either: acceptance looks the row up *by* the hash, so the indexed
 * equality is the comparison, and there is no second value to compare against in
 * process memory.
 */

/** Bytes of entropy per token. 32 bytes = 256 bits, base64url encoded. */
const TOKEN_BYTES = 32;

/** Hex digest length, and therefore the width of the `token_hash` column. */
export const TOKEN_HASH_HEX_LENGTH = 64;

/**
 * The raw token, in the form it goes into a URL.
 *
 * Base64url rather than hex: it carries the same 256 bits in 43 characters
 * instead of 64 and needs no percent-encoding, so the value survives a query
 * string, a path segment and an email client without being mangled.
 */
export type RawInvitationToken = string & {
	readonly __brand: "RawInvitationToken";
};

/**
 * A fresh, unguessable invitation token.
 *
 * `randomBytes` from `node:crypto` is a CSPRNG. `Math.random` would not be: it
 * is a deterministic generator whose state can be reconstructed from a handful
 * of outputs, which would make every issued token predictable to anyone who had
 * seen a few.
 */
export function generateInvitationToken(): RawInvitationToken {
	return randomBytes(TOKEN_BYTES).toString("base64url") as RawInvitationToken;
}

/**
 * The value stored in `token_hash` and matched on at acceptance.
 *
 * Fixed-width lowercase hex, which is what the `varchar(64)` column and the
 * unique index on it expect. Accepts a plain string as well as the branded token
 * so the request path can hash whatever arrived without a cast at the call site.
 */
export function hashInvitationToken(
	token: RawInvitationToken | string,
): string {
	return createHash("sha256").update(token, "utf8").digest("hex");
}
