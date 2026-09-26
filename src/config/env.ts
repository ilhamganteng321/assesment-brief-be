import "dotenv/config";
import { z } from "zod";

const positiveInt = (label: string) =>
	z.coerce
		.number(`${label} must be a number`)
		.int(`${label} must be an integer`)
		.positive(`${label} must be a positive number`);

export const envSchema = z
	.object({
		DATABASE_URL: z.string().url("DATABASE_URL must be a valid database URL"),
		JWT_SECRET: z.string().min(1, "JWT_SECRET is required"),
		JWT_EXPIRES_IN: z
			.string()
			.min(1, "JWT_EXPIRES_IN is required")
			.default("1d"),
		PORT: z.coerce
			.number()
			.int("PORT must be an integer")
			.positive("PORT must be a positive number")
			.max(65535, "PORT must be <= 65535")
			.default(3000),
		NODE_ENV: z.enum(["development", "test", "production"]),
		FRONTEND_URL: z
			.string()
			.trim()
			.min(1, "FRONTEND_URL must not be empty")
			.optional(),
		CORS_ORIGIN: z
			.string()
			.trim()
			.min(1, "CORS_ORIGIN must not be empty")
			.optional(),
		API_BASE_URL: z
			.string()
			.trim()
			.min(1, "API_BASE_URL must not be empty")
			.optional(),
		MAX_UPLOAD_SIZE_MB: positiveInt("MAX_UPLOAD_SIZE_MB").default(10),
		STORAGE_PROVIDER: z.enum(["local"]).default("local"),
		STORAGE_LOCAL_DIR: z
			.string()
			.min(1, "STORAGE_LOCAL_DIR must not be empty")
			.default("./storage/uploads"),
		RATE_LIMIT_MAX: positiveInt("RATE_LIMIT_MAX").default(100),
		RATE_LIMIT_WINDOW_SECONDS: positiveInt("RATE_LIMIT_WINDOW_SECONDS").default(
			60,
		),
		AUTH_RATE_LIMIT: positiveInt("AUTH_RATE_LIMIT").default(10),
		AUTH_RATE_WINDOW_SECONDS: positiveInt("AUTH_RATE_WINDOW_SECONDS").default(
			60,
		),
	})
	.superRefine((data, ctx) => {
		const corsOrigins = [
			...(data.FRONTEND_URL ?? "").split(","),
			...(data.CORS_ORIGIN ?? "").split(","),
		]
			.map((origin) => origin.trim())
			.filter((origin) => origin.length > 0);

		// A malformed origin is not a soft failure: it produces no CORS header at
		// all, so the deployed frontend is simply refused by every request and
		// the symptom points at the browser rather than at this file. Rejecting
		// it at boot names the mistake while there is still someone to read it.
		const originVariables = ["FRONTEND_URL", "CORS_ORIGIN"] as const;

		for (const variable of originVariables) {
			const value = data[variable];
			if (value === undefined) {
				continue;
			}
			for (const raw of value.split(",")) {
				const trimmed = raw.trim();
				if (trimmed.length === 0) {
					continue;
				}
				// Same rule the CORS middleware applies, inlined rather than
				// imported: this module must stay importable on its own, because
				// the middleware reads the environment this file produces.
				let valid = false;
				try {
					const url = new URL(trimmed);
					valid =
						(url.protocol === "http:" || url.protocol === "https:") &&
						url.username === "" &&
						url.password === "" &&
						url.search === "" &&
						url.hash === "" &&
						(url.pathname === "/" || url.pathname === "");
				} catch {
					valid = false;
				}
				if (!valid) {
					ctx.addIssue({
						code: "custom",
						path: [variable],
						message: `${variable} must be a bare origin such as https://app.example.com (no path, credentials, query or fragment); got "${trimmed}"`,
					});
				}
			}
		}

		if (data.NODE_ENV === "production") {
			if (corsOrigins.length === 0) {
				ctx.addIssue({
					code: "custom",
					path: ["FRONTEND_URL"],
					message:
						"FRONTEND_URL (or CORS_ORIGIN) with the deployed frontend origin is required in production",
				});
			}
			if (data.JWT_SECRET.length < 32) {
				ctx.addIssue({
					code: "custom",
					path: ["JWT_SECRET"],
					message: "JWT_SECRET must be at least 32 characters in production",
				});
			}
		}
	});

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
	console.error("[env] Invalid environment variables:");
	for (const issue of parsed.error.issues) {
		console.error(`  - ${issue.path.join(".")}: ${issue.message}`);
	}
	process.exit(1);
}

export const env = parsed.data;

export type Env = z.infer<typeof envSchema>;
