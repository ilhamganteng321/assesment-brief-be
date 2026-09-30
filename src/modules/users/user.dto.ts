import type { Models } from "../../prisma/contract";

/**
 * The columns read from `users` anywhere in the directory.
 *
 * `passwordHash` is excluded by construction, not by the response builder
 * dropping it afterwards. A whole-row select would load the credential hash and
 * rely on every projection to remember to remove it; naming the columns means the
 * secret is never read from the database, so it cannot be logged, cached, or
 * leaked by a later edit to a serializer.
 *
 * Shared with the project-member candidate search, which needs the same fields
 * and the same exclusion — one definition, so the two surfaces cannot drift into
 * disagreeing about what a user row contains.
 */
export type DirectoryUserRow = Pick<
	Models.public_Users,
	"id" | "name" | "email" | "role" | "department" | "createdAt"
>;

/** The same columns without the timestamp, for the member surfaces. */
export type DirectoryUserSummaryRow = Omit<DirectoryUserRow, "createdAt">;

/**
 * What a caller may see about a user.
 *
 * The full set, and the only set. `passwordHash` and every future security
 * column stay out by construction, because they are not on {@link DirectoryUserRow}
 * at all — there is no projection that could add them, since the type has no
 * room for them.
 */
export type UserSummary = {
	id: string;
	name: string;
	email: string;
	role: string;
	department: string;
	createdAt: string;
};

function toIsoString(value: unknown): string {
	if (typeof value === "string") {
		return value;
	}

	if (value instanceof Date) {
		return value.toISOString();
	}

	if (
		typeof value === "object" &&
		value !== null &&
		"toString" in value &&
		typeof value.toString === "function"
	) {
		return value.toString();
	}

	return String(value);
}

/**
 * Maps a stored row to the response.
 *
 * An allow-listed projection rather than a spread: `return { ...user }` would
 * carry every column forward, so adding a security column to `users` would publish
 * it to every caller of this endpoint with no code change to review.
 */
export function toUserSummary(user: DirectoryUserRow): UserSummary {
	return {
		id: user.id,
		name: user.name,
		email: user.email,
		role: user.role,
		department: user.department,
		createdAt: toIsoString(user.createdAt),
	};
}
