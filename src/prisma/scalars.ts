import type {
	CodecTypes,
	Varchar,
} from "@prisma/orm-postgres/target/codec-types";
import { blindCast } from "@prisma/orm-postgres/utils/casts";

// Must precede the `Temporal` lookup below, so the global exists even if this
// module is the first thing evaluated. See ./temporal.
import "./temporal";

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
		compare(a: string, b: string): -1 | 0 | 1;
		add(options: { days: number }): TimestampValue;
	};
	Instant: {
		from(
			value: string,
		): { toZonedDateTimeISO(timeZone: string): { toPlainDateTime(): TimestampValue } };
	};
};

/**
 * The runtime's `Temporal`, resolved on every call rather than captured when
 * this module is evaluated.
 *
 * Reading `globalThis.Temporal` once at module load looks equivalent and is not:
 * it freezes whatever was there at that instant, so a polyfill installed by a
 * later import would never be seen and every call would fail with "Temporal
 * polyfill is unavailable" even though the global now exists. A lookup per call
 * costs nothing and cannot be ordered wrongly.
 */
function temporalApi(): TemporalObject | undefined {
	return globalThis.Temporal as unknown as TemporalObject | undefined;
}

export function nowTimestamp(): TimestampValue {
	const value = temporalApi()?.Now.zonedDateTimeISO("UTC").toPlainDateTime();
	if (!value) {
		throw new Error(
			"Temporal is unavailable; timestamp cannot be generated. Import src/prisma/temporal before using this module.",
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
	const temporal = temporalApi();
	if (!temporal) {
		throw new Error(
			"Temporal is unavailable; timestamp cannot be parsed. Import src/prisma/temporal before using this module.",
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

/**
 * Orders two stored `timestamp` values.
 *
 * Through `Temporal.PlainDateTime.compare` rather than `<`. These values are
 * Temporal objects, and Temporal deliberately makes the usual JavaScript
 * coercions throw instead of silently producing a wrong answer — `valueOf` on a
 * `PlainDateTime` raises a TypeError precisely so nobody compares an instant
 * against a wall clock by accident. Calling compare is the supported way to ask
 * the question.
 *
 * `null` for an absent value, ordered before everything, so a caller can fold a
 * nullable column into a comparison chain without special-casing it: a row that
 * was never accepted is earlier than one that was.
 */
export function compareTimestamps(
	a: TimestampValue | null,
	b: TimestampValue,
): -1 | 0 | 1 | null {
	if (a === null) {
		return null;
	}
	const temporal = temporalApi();
	if (!temporal) {
		throw new Error(
			"Temporal is unavailable; timestamps cannot be compared. Import src/prisma/temporal before using this module.",
		);
	}
	return temporal.PlainDateTime.compare(String(a), String(b));
}

/**
 * A stored timestamp moved forward by whole days.
 *
 * The addition happens in Temporal rather than in milliseconds because the column
 * holds a wall clock. Adding `7 * 24 * 3600 * 1000` to a `Date` and formatting the
 * result is correct in UTC and off by an hour twice a year in any zone observing
 * daylight saving — and this value decides how long an invitation link stays open,
 * so a link that expires an hour early or late is a real, if occasional, failure.
 *
 * Precision is left as Temporal produces it, matching `nowTimestamp`. The column
 * stores microseconds and every other timestamp in the app is written at
 * millisecond precision, so rounding here would make this one column the odd one
 * out for no gain.
 */
export function addDaysToTimestamp(
	value: TimestampValue,
	days: number,
): TimestampValue {
	const temporal = temporalApi();
	if (!temporal) {
		throw new Error(
			"Temporal is unavailable; a timestamp cannot be advanced. Import src/prisma/temporal before using this module.",
		);
	}
	return temporal.PlainDateTime.from(String(value)).add({ days });
}
