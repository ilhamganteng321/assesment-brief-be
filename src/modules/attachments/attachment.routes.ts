import type { Context } from "hono";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { env } from "../../config/env";
import { errorResponse, successResponse } from "../../lib/response";
import type { AuthVariables } from "../../middleware/auth";
import { authRequired } from "../../middleware/auth";
import type { RequestIdVariables } from "../../middleware/request-id";
import { AttachmentFileMissingError } from "./attachment.errors";
import {
	attachmentIdParamSchema,
	attachmentListQuerySchema,
	attachmentTaskIdParamSchema,
	sanitizeContentDispositionName,
} from "./attachment.schema";
import { attachmentService } from "./attachment.service";

type AttachmentRoutesVariables = RequestIdVariables & AuthVariables;

type AttachmentRouteContext = Context<{
	Variables: AttachmentRoutesVariables;
}>;

export const attachmentRoutes = new Hono<{
	Variables: AttachmentRoutesVariables;
}>();

attachmentRoutes.use("*", authRequired);

const MAX_UPLOAD_SIZE_BYTES = env.MAX_UPLOAD_SIZE_MB * 1024 * 1024;

async function parseUploadedFile(c: AttachmentRouteContext): Promise<{
	projectId: string;
	taskId: string;
	file: {
		name: string;
		type: string;
		size: number;
		bytes(): Promise<Uint8Array>;
	};
}> {
	const { projectId, taskId } = attachmentTaskIdParamSchema.parse(
		c.req.param(),
	);

	const formData = await c.req.formData();
	const rawFile = formData.get("file");
	if (typeof rawFile === "string" || rawFile === null) {
		throw new AttachmentFileMissingError();
	}

	return {
		projectId,
		taskId,
		file: {
			name: rawFile.name,
			type: rawFile.type,
			size: rawFile.size,
			bytes: async () => new Uint8Array(await rawFile.arrayBuffer()),
		},
	};
}

attachmentRoutes.get("/:projectId/tasks/:taskId/attachments", async (c) => {
	const { projectId, taskId } = attachmentTaskIdParamSchema.parse(
		c.req.param(),
	);
	const query = attachmentListQuerySchema.parse(c.req.query());
	const result = await attachmentService.listAttachments(
		c.get("user"),
		projectId,
		taskId,
		query,
	);
	return c.json(successResponse(result));
});

attachmentRoutes.post(
	"/:projectId/tasks/:taskId/attachments",
	bodyLimit({
		maxSize: MAX_UPLOAD_SIZE_BYTES + 64 * 1024,
		onError: (c) =>
			c.json(
				errorResponse("ATTACHMENT_FILE_TOO_LARGE", "The file is too large"),
				413,
			),
	}),
	async (c) => {
		const { projectId, taskId, file } = await parseUploadedFile(c);
		const attachment = await attachmentService.uploadAttachment(
			c.get("user"),
			projectId,
			taskId,
			file,
		);
		return c.json(successResponse({ attachment }), 201);
	},
);

attachmentRoutes.get(
	"/:projectId/tasks/:taskId/attachments/:attachmentId",
	async (c) => {
		const { projectId, taskId, attachmentId } = attachmentIdParamSchema.parse(
			c.req.param(),
		);
		const result = await attachmentService.getAttachmentDownload(
			c.get("user"),
			projectId,
			taskId,
			attachmentId,
		);
		const payload = new Uint8Array(result.bytes);
		return c.body(payload, 200, {
			"Content-Type": result.attachment.mimeType,
			"Content-Disposition": `attachment; filename="${sanitizeContentDispositionName(
				result.attachment.fileName,
			)}"`,
			"Content-Length": String(payload.byteLength),
		});
	},
);

attachmentRoutes.delete(
	"/:projectId/tasks/:taskId/attachments/:attachmentId",
	async (c) => {
		const { projectId, taskId, attachmentId } = attachmentIdParamSchema.parse(
			c.req.param(),
		);
		await attachmentService.softDeleteAttachment(
			c.get("user"),
			projectId,
			taskId,
			attachmentId,
		);
		return c.body(null, 204);
	},
);
