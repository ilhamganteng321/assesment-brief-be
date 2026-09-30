import { or } from "@prisma/orm-postgres/orm-client";
import { db } from "../../prisma/db";
import { toTimestamp } from "../../prisma/scalars";
import type { UserContext } from "../authorization/authorization.types";
import type { DirectoryUserRow } from "./user.dto";
import { toUserSummary } from "./user.dto";
import {
	UserDirectoryAccessDeniedError,
	UserNotFoundError,
} from "./user.errors";
import { canListUsers, canViewUser } from "./user.policy";
import {
	DEFAULT_USER_LIST_QUERY,
	USER_DEPARTMENTS,
	USER_ROLES,
	type UserListQuery,
} from "./user.schema";

/**
 * The columns every user read in this module projects.
 *
 * Named on the query rather than selected whole. `passwordHash` is therefore
 * never read from the database on any path in the directory — a stronger
 * guarantee than projecting it away afterwards, because a secret that was never
 * loaded cannot be logged, cached, or leaked by a later edit to a serializer.
 */
const USER_COLUMNS = [
	"id",
	"name",
	"email",
	"role",
	"department",
	"createdAt",
] as const;

export type UserPagination = {
	page: number;
	limit: number;
	total: number;
	totalPages: number;
};

export type UserListResponse = {
	users: ReturnType<typeof toUserSummary>[];
	pagination: UserPagination;
};

/** One page of users, plus the count of everything that matched. */
export type UserPage = {
	users: DirectoryUserRow[];
	total: number;
};

function toPagination(
	page: number,
	limit: number,
	total: number,
): UserPagination {
	return {
		page,
		limit,
		total,
		totalPages: Math.ceil(total / limit),
	};
}

/**
 * Escapes the LIKE metacharacters so a search is a literal substring.
 *
 * Without this, a `%` or `_` typed into a search box widens the match beyond what
 * the user asked for, silently. Escaped once here and reused by both the
 * directory search and the project-member candidate search, so the two cannot
 * disagree about what a `%` means.
 */
function escapeLikePattern(value: string): string {
	return value.replace(/[\\%_]/g, "\\$&");
}

/**
 * Searches the organisation by name or email, server-side and paged.
 *
 * The one implementation behind both the directory's text search and the
 * project-member candidate search, so the two agree about what a match is and
 * neither can drift into its own definition of "contains".
 *
 * `or` above is the ORM's own combinator and that is load-bearing. Chaining two
 * field predicates with JavaScript's `||` inside a `where` callback does not throw
 * and does not warn — it compiles to a predicate that matches no rows at all, so
 * the search would silently return nothing for every query while looking like an
 * honest "no results" from the outside. `or` is what reaches SQL as an OR.
 */
export async function searchUsersByText(input: {
	search: string;
	page: number;
	rows: number;
}): Promise<UserPage> {
	const pattern = `%${escapeLikePattern(input.search.trim())}%`;
	const collection = db.orm.public.Users.where((user) =>
		or(user.name.ilike(pattern), user.email.ilike(pattern)),
	);

	// Counted on the same filtered collection as the page, so `total` and the rows
	// below it can never describe two different sets.
	const countResult = await collection.aggregate((aggregate) => ({
		total: aggregate.count(),
	}));

	const users = await collection
		.select(...USER_COLUMNS)
		// A stable secondary sort, so paging cannot show two people twice or skip
		// one between two requests for the same search.
		.orderBy((user) => user.name.asc())
		.orderBy((user) => user.id.asc())
		.limit(input.rows)
		.offset((input.page - 1) * input.rows)
		.all();

	return { users, total: countResult.total };
}

/**
 * The team directory.
 *
 * Paged, filtered, searched and ordered entirely in the database. The account
 * table is the one collection in this application with no natural bound, so
 * anything that filtered it in the browser would have to download all of it
 * first — and the directory is the surface where that would be least defensible,
 * because it is a list of everybody in the organisation.
 *
 * `orderKey` comes from a closed set validated by the query schema, so
 * `row[orderKey]` can only ever be a column that exists. Nothing from the request
 * reaches the SQL as a fragment.
 */
export async function listUsers(
	user: UserContext,
	query: UserListQuery = DEFAULT_USER_LIST_QUERY,
): Promise<UserListResponse> {
	if (!canListUsers(user)) {
		throw new UserDirectoryAccessDeniedError();
	}

	const { page, rows, filters, searchFilters, rangedFilters } = query;
	const orderRule = query.orderRule;
	const empty = (): UserListResponse => ({
		users: [],
		pagination: toPagination(page, rows, 0),
	});

	// The table proxy is itself chainable, so the unfiltered case needs no
	// placeholder predicate — each filter narrows it in turn.
	let collection = db.orm.public.Users;

	if (filters.id !== undefined) {
		const ids = (
			Array.isArray(filters.id) ? filters.id : [filters.id]
		) as string[];
		collection = collection.where((row) => row.id.in(ids));
	}

	if (filters.role !== undefined) {
		const requested = Array.isArray(filters.role)
			? filters.role
			: [filters.role];
		// Re-checked against the enum rather than trusted from the parsed query.
		// The schema already rejects an unknown role, so this cannot widen
		// anything — it exists so a filter that matches nobody reads as "no
		// results" instead of compiling to an `IN ()` that some dialects reject.
		const roles = requested.filter((role): role is string =>
			(USER_ROLES as readonly unknown[]).includes(role),
		);
		if (roles.length === 0) {
			return empty();
		}
		collection = collection.where((row) => row.role.in(roles as never[]));
	}

	if (filters.department !== undefined) {
		const requested = Array.isArray(filters.department)
			? filters.department
			: [filters.department];
		const departments = requested.filter((department): department is string =>
			(USER_DEPARTMENTS as readonly unknown[]).includes(department),
		);
		if (departments.length === 0) {
			return empty();
		}
		collection = collection.where((row) =>
			row.department.in(departments as never[]),
		);
	}

	// The directory's single search box sends its text under `name`, which matches
	// a name *or* an address — for a person, "name" is the human word for "who
	// they are", and people are looked up by either. `email` is the precise
	// alternative: it matches the address alone, so a caller who wants exactly
	// that can ask for it. Both together narrow, rather than widen.
	if (searchFilters.name !== undefined) {
		const pattern = `%${escapeLikePattern(searchFilters.name)}%`;
		collection = collection.where((row) =>
			or(row.name.ilike(pattern), row.email.ilike(pattern)),
		);
	}
	if (searchFilters.email !== undefined) {
		const pattern = `%${escapeLikePattern(searchFilters.email)}%`;
		collection = collection.where((row) => row.email.ilike(pattern));
	}

	for (const range of rangedFilters) {
		if (range.key !== "createdAt" && range.key !== "updatedAt") {
			continue;
		}
		const field = range.key;
		if (range.start !== undefined) {
			collection = collection.where((row) =>
				row[field].gte(toTimestamp(range.start as string)),
			);
		}
		if (range.end !== undefined) {
			collection = collection.where((row) =>
				row[field].lte(toTimestamp(range.end as string)),
			);
		}
	}

	const countResult = await collection.aggregate((aggregate) => ({
		total: aggregate.count(),
	}));

	const orderKey = query.orderKey ?? "createdAt";
	const users = await collection
		.select(...USER_COLUMNS)
		// The secondary sort keeps paging stable: without it, two people sharing a
		// name could trade places between two requests and one would be skipped.
		.orderBy((row) =>
			orderRule === "asc" ? row[orderKey].asc() : row[orderKey].desc(),
		)
		.orderBy((row) => row.id.asc())
		.limit(rows)
		.offset((page - 1) * rows)
		.all();

	return {
		users: users.map(toUserSummary),
		pagination: toPagination(page, rows, countResult.total),
	};
}

/**
 * One user, for the profile view.
 *
 * Refused identically whether the id does not exist or the caller may not ask, so
 * the endpoint cannot be used to probe which accounts exist. A caller who passes
 * the gate always gets the real user.
 */
export async function getUserById(
	user: UserContext,
	targetUserId: string,
): Promise<ReturnType<typeof toUserSummary>> {
	if (!canViewUser(user)) {
		throw new UserDirectoryAccessDeniedError();
	}

	const target = await db.orm.public.Users.where((row) =>
		row.id.eq(targetUserId),
	)
		.select(...USER_COLUMNS)
		.first();
	if (!target) {
		throw new UserNotFoundError();
	}

	return toUserSummary(target);
}
