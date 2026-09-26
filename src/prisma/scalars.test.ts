import { describe, expect, test } from "bun:test";

import { toTimestamp } from "./scalars";

// ---------------------------------------------------------------------------
// Timestamp parsing for the range filters.
//
// The columns are `timestamp without time zone`, so the stored wall clock is
// UTC. The request schema accepts anything `Date.parse` accepts, which includes
// the `Z` and `+02:00` forms that a client is most likely to send. Parsing those
// has to normalise them to UTC rather than throw, because an unhandled
// `RangeError` here became a 500 on a perfectly valid request.
// ---------------------------------------------------------------------------

/** Reads a PlainDateTime back as an ISO string for comparison. */
const asIso = (value: unknown): string =>
	String((value as { toString(): string }).toString());

describe("toTimestamp", () => {
	test("parses a plain local date-time unchanged", () => {
		expect(asIso(toTimestamp("2026-01-01T00:00:00"))).toContain("2026-01-01");
	});

	test("accepts a UTC designator, which PlainDateTime.from alone rejects", () => {
		expect(asIso(toTimestamp("2026-01-01T00:00:00Z"))).toContain("2026-01-01");
	});

	test("accepts fractional seconds with a UTC designator", () => {
		expect(asIso(toTimestamp("2026-01-01T12:34:56.789Z"))).toContain("2026-01-01");
	});

	test("normalises a positive offset to UTC", () => {
		// 14:00 at +02:00 is 12:00 UTC, so the wall clock has to move back.
		expect(asIso(toTimestamp("2026-01-01T14:00:00+02:00"))).toContain("12:00:00");
	});

	test("normalises a negative offset to UTC", () => {
		// 09:00 at -03:00 is 12:00 UTC.
		expect(asIso(toTimestamp("2026-01-01T09:00:00-03:00"))).toContain("12:00:00");
	});

	test("a bare date is not mistaken for an offset", () => {
		// The `-01` in `2026-01-01` must not be read as a UTC offset.
		expect(asIso(toTimestamp("2026-01-01"))).toContain("2026-01-01");
	});

	test("the same instant written two ways agrees", () => {
		expect(asIso(toTimestamp("2026-03-04T05:06:07Z"))).toBe(
			asIso(toTimestamp("2026-03-04T07:06:07+02:00")),
		);
	});

	test("a value that is not a date is refused", () => {
		expect(() => toTimestamp("not-a-date")).toThrow();
	});
});
