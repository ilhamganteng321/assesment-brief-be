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
