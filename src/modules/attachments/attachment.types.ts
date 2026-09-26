import type { z } from "zod";
import type { Models } from "../../prisma/contract";
import type { Pagination } from "../tasks/task.types";
import type { attachmentListQuerySchema } from "./attachment.schema";

export type AttachmentRecord = Omit<
	Models.public_Attachments,
	"task" | "uploadedBy"
>;

export type AttachmentUploader = {
	id: string;
	name: string;
};

export type AttachmentResponse = Pick<
	AttachmentRecord,
	"id" | "taskId" | "fileName" | "mimeType" | "fileSize" | "createdAt"
> & {
	uploadedBy: AttachmentUploader;
};

export type AttachmentListResponse = {
	attachments: AttachmentResponse[];
	pagination: Pagination;
};

export type AttachmentListQuery = z.infer<typeof attachmentListQuerySchema>;

export type AttachmentDownload = {
	attachment: AttachmentResponse;
	bytes: Uint8Array;
};

export type UploadedFileSource = {
	name: string;
	type: string;
	size: number;
	bytes(): Promise<Uint8Array>;
};
