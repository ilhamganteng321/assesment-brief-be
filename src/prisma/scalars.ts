import type {
	CodecTypes,
	Varchar,
} from "@prisma/orm-postgres/target/codec-types";
import { blindCast } from "@prisma/orm-postgres/utils/casts";

export const toVarchar = <N extends number>(value: string): Varchar<N> =>
	blindCast<
		Varchar<N>,
		"Prisma 8 emits Varchar<N> as a branded string with no public constructor; validated request strings are paired with the column type"
	>(value);

export type TimestampValue = CodecTypes["pg/timestamp-temporal@1"]["input"];

/**
 * What a `timestamp` column reads back as.
 *
 * The columns are `timestamp without time zone`, so a row comes back as a
 * Temporal `PlainDateTime` rather than a `Date`. Anything that wants to describe
 * a stored timestamp has to name this type instead of reaching for `Date`.
 */
export type StoredTimestamp = CodecTypes["pg/timestamp-temporal@1"]["output"];

type TemporalObject = {
	Now: {
		zonedDateTimeISO(timeZone: string): { toPlainDateTime(): TimestampValue };
	};
	PlainDateTime: {
		from(value: string): TimestampValue;
	};
	Instant: {
		from(
			value: string,
		): { toZonedDateTimeISO(timeZone: string): { toPlainDateTime(): TimestampValue } };
	};
};

const temporal = globalThis.Temporal as unknown as TemporalObject | undefined;

export function nowTimestamp(): TimestampValue {
	const value = temporal?.Now.zonedDateTimeISO("UTC").toPlainDateTime();
	if (!value) {
		throw new Error(
			"Temporal polyfill is unavailable; timestamp cannot be generated",
		);
	}
	return value;
}

/**
 * A trailing `Z` or a numeric offset such as `+02:00`. Deliberately requires
 * four offset digits so that the `-01` in a bare `2026-01-01` is not mistaken
 * for one.
 */
const HAS_UTC_OFFSET = /(?:Z|[+-]\d{2}:?\d{2})$/i;

export function toTimestamp(value: string): TimestampValue {
	if (!temporal) {
		throw new Error(
			"Temporal polyfill is unavailable; timestamp cannot be parsed",
		);
	}

	// The columns are `timestamp without time zone`, so the wall clock is UTC.
	// `PlainDateTime.from` refuses any string carrying an offset, even though the
	// request schema accepts anything `Date.parse` does, so a client sending the
	// ordinary `...T00:00:00.000Z` form used to reach here and throw a RangeError
	// that surfaced as a 500. Normalise those through an instant first.
	if (HAS_UTC_OFFSET.test(value)) {
		return temporal.Instant.from(value)
			.toZonedDateTimeISO("UTC")
			.toPlainDateTime();
	}

	return temporal.PlainDateTime.from(value);
}
