import { z } from "zod";

export const DEPARTMENTS = [
	"PRODUCT",
	"UI_UX",
	"FRONTEND",
	"BACKEND",
	"CLIENT",
] as const;

const emailSchema = z
	.string()
	.trim()
	.toLowerCase()
	.email("A valid email address is required")
	.max(255, "Email must be at most 255 characters");

const departmentSchema = z.enum(DEPARTMENTS);

// Both schemas are strict so that an unexpected key is reported rather than
// silently dropped. A plain `z.object()` would quietly discard `role`, which is
// safe today only because the service hard-codes the new account's role; a
// reviewer submitting `role: "PM"` deserves to be told the field does not exist
// instead of receiving a success. This also matches the task endpoints, which
// already reject unknown keys.
export const registerSchema = z.strictObject({
	name: z
		.string()
		.trim()
		.min(1, "Name is required")
		.max(100, "Name must be at most 100 characters"),
	email: emailSchema,
	password: z
		.string()
		.min(8, "Password must be at least 8 characters")
		.max(72, "Password must be at most 72 characters"),
	department: departmentSchema.optional(),
});

export type RegisterInput = z.infer<typeof registerSchema>;

export const loginSchema = z.strictObject({
	email: emailSchema,
	password: z.string().min(1, "Password is required"),
});

export type LoginInput = z.infer<typeof loginSchema>;
