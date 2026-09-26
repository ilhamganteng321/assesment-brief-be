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

type TemporalObject = {
	Now: {
		zonedDateTimeISO(timeZone: string): { toPlainDateTime(): TimestampValue };
	};
	PlainDateTime: {
		from(value: string): TimestampValue;
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

export function toTimestamp(value: string): TimestampValue {
	const parsed = temporal?.PlainDateTime.from(value);
	if (!parsed) {
		throw new Error(
			"Temporal polyfill is unavailable; timestamp cannot be parsed",
		);
	}
	return parsed;
}
