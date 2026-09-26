import { Temporal } from "temporal-polyfill";

// ---------------------------------------------------------------------------
// Guarantees a `Temporal` global before any Postgres timestamp is touched.
//
// Prisma 8 stores every `timestamp` column through the `pg/timestamp-temporal@1`
// codec, and that codec does this on the way out of the database:
//
//   if (typeof Temporal === "undefined") throw errorTemporalUnavailable(...)
//
// `Temporal` is still a recent addition to the runtimes this app is deployed on.
// Bun only exposes it from 1.3 onwards, and Node does not expose it at all, so
// on an older Bun or on Node the very first query that reads a row fails with
// "Codec 'pg/timestamp-temporal@1' cannot decode a value because this runtime
// has no global Temporal implementation". It reaches login because that is
// usually the first thing that reads a user row, which makes it look like an
// auth problem rather than a missing runtime primitive.
//
// The polyfill is installed only when the runtime has nothing, so a runtime that
// does provide Temporal keeps using its own implementation.
//
// Importing this module is a side effect and must stay at the top of any module
// that reads or writes a timestamp. `db.ts` and `scalars.ts` both import it.
// ---------------------------------------------------------------------------

if (typeof globalThis.Temporal === "undefined") {
	Object.defineProperty(globalThis, "Temporal", {
		value: Temporal,
		writable: true,
		enumerable: false,
		configurable: true,
	});
}
