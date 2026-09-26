import { describe, expect, test } from "bun:test";
import type {
	ProjectAuthorizationContext,
	UserContext,
} from "../authorization/authorization.types";
import { AttachmentFileTooLargeError } from "./attachment.errors";
import {
	canAccessProjectAttachments,
	canUploadAttachment,
} from "./attachment.policy";
import {
	ATTACHMENT_ALLOWED_MIME_TYPES,
	attachmentIdParamSchema,
	attachmentListQuerySchema,
	attachmentProjectIdParamSchema,
	attachmentTaskIdParamSchema,
	detectAttachmentMimeType,
	sanitizeAttachmentFileName,
	sanitizeContentDispositionName,
} from "./attachment.schema";

const pm: UserContext = { id: "pm-1", role: "PM", department: "PRODUCT" };
const internal: UserContext = {
	id: "fe-1",
	role: "INTERNAL",
	department: "FRONTEND",
};
const client: UserContext = {
	id: "cl-1",
	role: "CLIENT",
	department: "CLIENT",
};

const PROJECT_ID = "9f8e7d6c-5b4a-4321-9876-0fedcba98765";
const TASK_ID = "3c9a1e8a-6d5b-4f21-9c3f-8f0d1a2b3c4d";
const ATTACHMENT_ID = "1a2b3c4d-5e6f-4789-9abc-def012345678";

function project(memberIds: readonly string[]): ProjectAuthorizationContext {
	return {
		id: PROJECT_ID,
		status: "ACTIVE",
		memberships: memberIds.map((userId) => ({ userId })),
	};
}

const PNG_MAGIC_BYTES = new Uint8Array([
	0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0xff, 0x01, 0x02,
]);
const JPEG_MAGIC_BYTES = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]);
const PDF_MAGIC_BYTES = new TextEncoder().encode("%PDF-1.7\n...");
const ZIP_MAGIC_BYTES = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0x14, 0x00]);
const EXE_MAGIC_BYTES = new Uint8Array([0x4d, 0x5a, 0x90, 0x00]);
const PLAIN_TEXT_BYTES = new TextEncoder().encode("hello world");

function webpMagic(): Uint8Array {
	const bytes = new Uint8Array(20);
	for (let index = 0; index < 4; index++) {
		bytes[index] = "RIFF".charCodeAt(index);
	}
	for (let index = 0; index < 4; index++) {
		bytes[8 + index] = "WEBP".charCodeAt(index);
	}
	return bytes;
}

describe("attachment policy", () => {
	test("client is never allowed to access project attachments", () => {
		expect(canAccessProjectAttachments(client, project([client.id]))).toBe(
			false,
		);
		expect(canAccessProjectAttachments(client, project([]))).toBe(false);
	});

	test("pm can access attachments in any project", () => {
		expect(canAccessProjectAttachments(pm, project([]))).toBe(true);
	});

	test("internal can access attachments only in member projects", () => {
		expect(canAccessProjectAttachments(internal, project([internal.id]))).toBe(
			true,
		);
		expect(canAccessProjectAttachments(internal, project([]))).toBe(false);
	});

	test("only internal roles can upload attachments", () => {
		expect(canUploadAttachment(pm)).toBe(true);
		expect(canUploadAttachment(internal)).toBe(true);
		expect(canUploadAttachment(client)).toBe(false);
	});
});

describe("attachment schema - params", () => {
	test("project id param accepts valid uuid", () => {
		const parsed = attachmentProjectIdParamSchema.parse({
			projectId: PROJECT_ID,
		});
		expect(parsed.projectId).toBe(PROJECT_ID);
	});

	test("project id param rejects malformed id", () => {
		expect(() =>
			attachmentProjectIdParamSchema.parse({ projectId: "not-a-uuid" }),
		).toThrow();
	});

	test("task id param requires project and task ids", () => {
		const parsed = attachmentTaskIdParamSchema.parse({
			projectId: PROJECT_ID,
			taskId: TASK_ID,
		});
		expect(parsed).toEqual({ projectId: PROJECT_ID, taskId: TASK_ID });
	});

	test("task id param rejects missing task id", () => {
		expect(() =>
			attachmentTaskIdParamSchema.parse({ projectId: PROJECT_ID }),
		).toThrow();
	});

	test("attachment id param accepts all three ids", () => {
		const parsed = attachmentIdParamSchema.parse({
			projectId: PROJECT_ID,
			taskId: TASK_ID,
			attachmentId: ATTACHMENT_ID,
		});
		expect(parsed.attachmentId).toBe(ATTACHMENT_ID);
	});
});

describe("attachment schema - list query", () => {
	test("list query applies defaults", () => {
		const parsed = attachmentListQuerySchema.parse({});
		expect(parsed).toEqual({ page: 1, limit: 20, mimeType: undefined });
	});

	test("list query coerces page and limit", () => {
		const parsed = attachmentListQuerySchema.parse({
			page: "2",
			limit: "10",
		});
		expect(parsed.page).toBe(2);
		expect(parsed.limit).toBe(10);
	});

	test("list query accepts allowed mime type", () => {
		const parsed = attachmentListQuerySchema.parse({ mimeType: "image/png" });
		expect(parsed.mimeType).toBe("image/png");
	});

	test("list query rejects unsupported mime type", () => {
		expect(() =>
			attachmentListQuerySchema.parse({ mimeType: "text/plain" }),
		).toThrow();
	});
});

describe("attachment mime detection", () => {
	test("detects png from magic bytes", () => {
		expect(
			detectAttachmentMimeType(PNG_MAGIC_BYTES, "application/octet-stream"),
		).toBe("image/png");
	});

	test("detects jpeg from magic bytes", () => {
		expect(detectAttachmentMimeType(JPEG_MAGIC_BYTES, "")).toBe("image/jpeg");
	});

	test("detects webp from RIFF/WEBP magic bytes", () => {
		expect(detectAttachmentMimeType(webpMagic(), "image/webp")).toBe(
			"image/webp",
		);
	});

	test("detects pdf from magic bytes", () => {
		expect(detectAttachmentMimeType(PDF_MAGIC_BYTES, "application/pdf")).toBe(
			"application/pdf",
		);
	});

	test("detects zip from magic bytes", () => {
		expect(detectAttachmentMimeType(ZIP_MAGIC_BYTES, "application/zip")).toBe(
			"application/zip",
		);
	});

	test("rejects mismatched declared mime type", () => {
		expect(detectAttachmentMimeType(PNG_MAGIC_BYTES, "image/jpeg")).toBeNull();
	});

	test("rejects untyped text content", () => {
		expect(detectAttachmentMimeType(PLAIN_TEXT_BYTES, "text/plain")).toBeNull();
	});

	test("rejects executable magic bytes", () => {
		expect(
			detectAttachmentMimeType(EXE_MAGIC_BYTES, "application/octet-stream"),
		).toBeNull();
	});

	test("rejects empty content", () => {
		expect(detectAttachmentMimeType(new Uint8Array(), "application/pdf")).toBe(
			null,
		);
	});

	test("declared type is normalized (uppercase + parameters)", () => {
		expect(
			detectAttachmentMimeType(PNG_MAGIC_BYTES, "Image/PNG; name=x.png"),
		).toBe("image/png");
	});
});

describe("attachment file name sanitization", () => {
	test("strips client path prefixes and keeps base name", () => {
		expect(sanitizeAttachmentFileName("C:\\fakepath\\report.pdf")).toBe(
			"report.pdf",
		);
		expect(sanitizeAttachmentFileName("../../etc/photos/scan.png")).toBe(
			"scan.png",
		);
	});

	test("removes control characters and header unsafe characters", () => {
		const cleaned = sanitizeAttachmentFileName('a\r\n"b"=scan.webp');
		expect(cleaned).toBe("abscan.webp");
		expect(cleaned).not.toContain("\r");
		expect(cleaned).not.toContain("\n");
		expect(cleaned).not.toContain('"');
	});

	test("returns null for empty or invalid names", () => {
		expect(sanitizeAttachmentFileName("")).toBeNull();
		expect(sanitizeAttachmentFileName("   ")).toBeNull();
		expect(sanitizeAttachmentFileName("...")).toBeNull();
		expect(sanitizeAttachmentFileName("\r\n\t")).toBeNull();
	});

	test("truncates overly long names", () => {
		const longName = `${"a".repeat(500)}.png`;
		expect(sanitizeAttachmentFileName(longName)?.length).toBeLessThanOrEqual(
			200,
		);
		expect(sanitizeAttachmentFileName(longName)).not.toBeNull();
	});
});

describe("content disposition name sanitization", () => {
	test("keeps safe names", () => {
		expect(sanitizeContentDispositionName("report.pdf")).toBe("report.pdf");
	});

	test("strips header injection characters", () => {
		const result = sanitizeContentDispositionName('scan;"\r\nX-Evil: 1".png');
		expect(result).not.toContain("\r");
		expect(result).not.toContain("\n");
		expect(result).not.toContain('"');
		expect(result).not.toContain(";");
	});

	test("falls back to a generic name when empty", () => {
		expect(sanitizeContentDispositionName('";\r\n\\;')).toBe("attachment.bin");
	});
});

describe("attachment errors", () => {
	test("file too large error carries the max size and 413 status", () => {
		const error = new AttachmentFileTooLargeError(10 * 1024 * 1024);
		expect(error.status).toBe(413);
		expect(error.code).toBe("ATTACHMENT_FILE_TOO_LARGE");
		expect(error.details).toEqual({ maxSizeBytes: 10 * 1024 * 1024 });
	});

	test("allowed mime types only contains supported types", () => {
		expect(ATTACHMENT_ALLOWED_MIME_TYPES).toEqual([
			"image/png",
			"image/jpeg",
			"image/webp",
			"application/pdf",
			"application/zip",
		]);
	});
});
