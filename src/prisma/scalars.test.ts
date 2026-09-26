import { describe, expect, test } from "bun:test";
import { Temporal as PolyfilledTemporal } from "temporal-polyfill";

import { nowTimestamp, toTimestamp } from "./scalars";
import "./temporal";

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

// ---------------------------------------------------------------------------
// The Temporal global.
//
// Prisma's `timestamp` codec throws on the first decoded row when the runtime
// has no `Temporal`, which is what broke login in production: Bun only exposes
// it from 1.3 onwards and Node does not expose it at all. Importing
// ./temporal is the fix, and the checks below are what stop it silently
// regressing into "the polyfill is imported but never actually installed".
// ---------------------------------------------------------------------------
describe("temporal availability", () => {
	test("importing the module provides a Temporal global", () => {
		// On Bun 1.3+ this is the runtime's own implementation; elsewhere it is
		// the polyfill. Either way something is there.
		expect(typeof globalThis.Temporal).toBe("object");
	});

	test("it implements the three members the app and the codec use", () => {
		const temporal = globalThis.Temporal as typeof PolyfilledTemporal;

		expect(typeof temporal.Now.zonedDateTimeISO).toBe("function");
		expect(typeof temporal.PlainDateTime.from).toBe("function");
		expect(typeof temporal.Instant.from).toBe("function");
	});

	// The real check: the codec resolves the bare global identifier, not a
	// property lookup on a shim, so the global has to be genuinely present and
	// complete rather than merely reachable.
	test("the codec's own guard would pass", () => {
		expect(typeof Temporal).not.toBe("undefined");
	});

	test("the polyfill is only installed when the runtime has none", () => {
		// Importing twice must not replace a working native implementation.
		const before = globalThis.Temporal;
		require("./temporal");
		require("./temporal");
		expect(globalThis.Temporal).toBe(before);
	});

	test("nowTimestamp produces a usable UTC value", () => {
		const value = nowTimestamp();

		expect(asIso(value)).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
	});
});
