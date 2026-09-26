import { z } from "zod";

export const ATTACHMENT_ALLOWED_MIME_TYPES = [
	"image/png",
	"image/jpeg",
	"image/webp",
	"application/pdf",
	"application/zip",
] as const;

export type AllowedAttachmentMimeType =
	(typeof ATTACHMENT_ALLOWED_MIME_TYPES)[number];

const MAX_FILE_NAME_LENGTH = 200;

const uuidSchema = z.string().uuid("A valid uuid is required");

export const attachmentProjectIdParamSchema = z.strictObject({
	projectId: uuidSchema,
});

export const attachmentTaskIdParamSchema = z.strictObject({
	projectId: uuidSchema,
	taskId: uuidSchema,
});

export const attachmentIdParamSchema = z.strictObject({
	projectId: uuidSchema,
	taskId: uuidSchema,
	attachmentId: uuidSchema,
});

export const attachmentListQuerySchema = z.strictObject({
	page: z.coerce
		.number()
		.int("page must be an integer")
		.min(1, "page must be at least 1")
		.default(1),
	limit: z.coerce
		.number()
		.int("limit must be an integer")
		.min(1, "limit must be at least 1")
		.max(100, "limit must be at most 100")
		.default(20),
	mimeType: z.enum(ATTACHMENT_ALLOWED_MIME_TYPES).optional(),
});

function startsWith(bytes: Uint8Array, prefix: readonly number[]): boolean {
	if (bytes.length < prefix.length) {
		return false;
	}
	return prefix.every((byte, index) => (bytes[index] ?? -1) === byte);
}

function asciiAt(bytes: Uint8Array, offset: number, expected: string): boolean {
	if (bytes.length < offset + expected.length) {
		return false;
	}
	for (let index = 0; index < expected.length; index++) {
		if ((bytes[offset + index] ?? -1) !== expected.charCodeAt(index)) {
			return false;
		}
	}
	return true;
}

const PNG_MAGIC = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const JPEG_MAGIC = [0xff, 0xd8, 0xff];
const ZIP_MAGIC = [0x50, 0x4b];

function detectByMagic(bytes: Uint8Array): AllowedAttachmentMimeType | null {
	if (startsWith(bytes, PNG_MAGIC)) {
		return "image/png";
	}
	if (startsWith(bytes, JPEG_MAGIC)) {
		return "image/jpeg";
	}
	if (asciiAt(bytes, 0, "RIFF") && asciiAt(bytes, 8, "WEBP")) {
		return "image/webp";
	}
	if (asciiAt(bytes, 0, "%PDF-")) {
		return "application/pdf";
	}
	if (startsWith(bytes, ZIP_MAGIC)) {
		const zipVariant = bytes[2];
		if (zipVariant !== undefined && [0x03, 0x05, 0x07].includes(zipVariant)) {
			return "application/zip";
		}
	}
	return null;
}

function normalizedDeclaredType(declaredType: string): string | null {
	const normalized = (declaredType.split(";")[0] ?? "").trim().toLowerCase();
	return normalized.length === 0 ? null : normalized;
}

export function detectAttachmentMimeType(
	bytes: Uint8Array,
	declaredType: string,
): AllowedAttachmentMimeType | null {
	if (bytes.length === 0) {
		return null;
	}

	const detected = detectByMagic(bytes);
	if (detected === null) {
		return null;
	}

	const declared = normalizedDeclaredType(declaredType);
	if (
		declared !== null &&
		ATTACHMENT_ALLOWED_MIME_TYPES.includes(
			declared as AllowedAttachmentMimeType,
		) &&
		declared !== detected
	) {
		return null;
	}

	return detected;
}

export function sanitizeAttachmentFileName(rawFileName: string): string | null {
	const baseName = rawFileName.replace(/\\/g, "/").split("/").pop() ?? "";
	const withoutControlCharacters = baseName.replace(/[\p{C}\u00A0]/gu, "");
	const withoutHeaderUnsafeCharacters = withoutControlCharacters.replace(
		/["\\;=\r\n]/g,
		"",
	);
	const trimmed = withoutHeaderUnsafeCharacters.trim().replace(/^\.+/, "");

	if (trimmed.length === 0) {
		return null;
	}

	return trimmed.slice(0, MAX_FILE_NAME_LENGTH);
}

export function sanitizeContentDispositionName(rawName: string): string {
	const safe = rawName.replace(/["\\\r\n;]/g, "").trim();
	return safe.length === 0 ? "attachment.bin" : safe;
}
