import jwt from "jsonwebtoken";
import { env } from "../../config/env";
import { HttpError } from "../../lib/http-error";
import { db } from "../../prisma/db";
import { toVarchar } from "../../prisma/scalars";
import { loginSchema, registerSchema } from "./auth.schema";
import type { AuthSession, SafeUser } from "./auth.types";
import { hashPassword, verifyPassword } from "./password";

const EXPIRY_VALUE_RE = /^(\d+(?:\.\d+)?)\s*(ms|s|m|h|d|w|y)?$/i;

function expirySeconds(value: string): number {
	const match = EXPIRY_VALUE_RE.exec(value);
	if (!match) {
		throw new HttpError(
			500,
			"INVALID_CONFIG",
			'JWT_EXPIRES_IN must be a duration like "1h", "7d" or "3600"',
		);
	}
	const amount = Number(match[1]);
	switch ((match[2] ?? "ms").toLowerCase()) {
		case "ms":
			return amount / 1000;
		case "s":
			return amount;
		case "m":
			return amount * 60;
		case "h":
			return amount * 3600;
		case "d":
			return amount * 86400;
		case "w":
			return amount * 604800;
		case "y":
			return amount * 31557600;
		default:
			throw new HttpError(
				500,
				"INVALID_CONFIG",
				'JWT_EXPIRES_IN must be a duration like "1h", "7d" or "3600"',
			);
	}
}

function signAccessToken(userId: string): string {
	return jwt.sign({ sub: userId }, env.JWT_SECRET, {
		algorithm: "HS256",
		expiresIn: expirySeconds(env.JWT_EXPIRES_IN),
	});
}

export function verifyAccessToken(token: string): string {
	try {
		const decoded = jwt.verify(token, env.JWT_SECRET, {
			algorithms: ["HS256"],
		});
		if (typeof decoded === "string" || typeof decoded.sub !== "string") {
			throw new Error("Access token is missing a subject");
		}
		return decoded.sub;
	} catch {
		throw new HttpError(401, "UNAUTHORIZED", "Invalid or expired access token");
	}
}

export async function register(rawInput: unknown): Promise<AuthSession> {
	const input = registerSchema.parse(rawInput);

	const email = toVarchar<255>(input.email);
	const existing = await db.orm.public.Users.where((u) => u.email.eq(email))
		.select("id")
		.first();

	if (existing) {
		throw new HttpError(
			409,
			"EMAIL_ALREADY_REGISTERED",
			"An account with this email already exists",
		);
	}

	const passwordHash = await hashPassword(input.password);
	const user = await db.orm.public.Users.select(
		"id",
		"name",
		"email",
		"role",
		"department",
	).create({
		name: toVarchar<100>(input.name),
		email,
		passwordHash,
		role: "INTERNAL",
		department: input.department ?? "PRODUCT",
	});

	return { user, accessToken: signAccessToken(user.id) };
}

export async function login(rawInput: unknown): Promise<AuthSession> {
	const input = loginSchema.parse(rawInput);

	const row = await db.orm.public.Users.where((u) =>
		u.email.eq(toVarchar<255>(input.email)),
	).first();

	const passwordMatches =
		row != null && (await verifyPassword(input.password, row.passwordHash));

	if (!row || !passwordMatches) {
		throw new HttpError(
			401,
			"INVALID_CREDENTIALS",
			"Invalid email or password",
		);
	}

	return {
		user: toSafeUser(row),
		accessToken: signAccessToken(row.id),
	};
}

export async function getCurrentUser(userId: string): Promise<SafeUser> {
	const row = await db.orm.public.Users.first({ id: userId });
	if (!row) {
		throw new HttpError(404, "USER_NOT_FOUND", "The account no longer exists");
	}
	return toSafeUser(row);
}

function toSafeUser(row: SafeUser): SafeUser {
	return {
		id: row.id,
		name: row.name,
		email: row.email,
		role: row.role,
		department: row.department,
	};
}
