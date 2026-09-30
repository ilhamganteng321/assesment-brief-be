import { z } from "zod";

/**
 * Email as an invitation addresses it.
 *
 * The same normalization the auth module applies, and for the same reason: the
 * comparison that decides whether the signed-in account may accept is a string
 * equality against the stored address, so `Ada@Example.com` and `ada@example.com`
 * have to be the same value at write time or the recipient is locked out of an
 * invitation sent to themselves. Trimming and lowercasing here means the stored
 * value is already canonical, and acceptance can compare without normalizing
 * twice and hoping both sides did it.
 */
export const invitationEmailSchema = z
	.string()
	.trim()
	.toLowerCase()
	.email("A valid email address is required")
	.max(255, "Email must be at most 255 characters");

/**
 * The body of `POST /projects/:projectId/invitations`.
 *
 * Strict, like every other request body in this codebase, so a caller that
 * sends `userId` or `role` — both of which would read as "invite this existing
 * person straight in" — is told the field does not exist instead of being
 * silently given an invitation that will quietly fail to match anybody.
 */
export const createInvitationSchema = z.strictObject({
	email: invitationEmailSchema,
});

export type CreateInvitationInput = z.infer<typeof createInvitationSchema>;

export const projectIdParamsSchema = z.strictObject({
	projectId: z.string().uuid("A valid project id is required"),
});

export const invitationParamsSchema = z.strictObject({
	projectId: z.string().uuid("A valid project id is required"),
	invitationId: z.string().uuid("A valid invitation id is required"),
});

/**
 * The token shape, checked before anything else looks at it.
 *
 * 43 characters is exactly what 32 bytes of entropy encode to in base64url. A
 * value that is not that shape cannot have come from `generateInvitationToken`,
 * so it is rejected without a database round trip — which keeps a scanner
 * probing this endpoint from turning every attempt into a query.
 *
 * Deliberately the *only* check on the token. Whether it is the right token, and
 * whether the project can still be joined, are questions for the service, which
 * answers them with the same code a nonexistent invitation gets.
 */
export const invitationTokenParamsSchema = z.strictObject({
	token: z
		.string()
		.regex(/^[A-Za-z0-9_-]{43}$/, "Invitation link is not valid"),
});

export type InvitationTokenParams = z.infer<typeof invitationTokenParamsSchema>;
