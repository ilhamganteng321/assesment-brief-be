import { randomUUID } from "node:crypto";
import { env } from "../../config/env";
import type { Models } from "../../prisma/contract";
import { db } from "../../prisma/db";
import { nowTimestamp, toVarchar } from "../../prisma/scalars";
import type {
	ProjectAuthorizationContext,
	UserContext,
} from "../authorization/authorization.types";
import { ProjectNotFoundError } from "../projects/project.errors";
import { TaskNotFoundError } from "../tasks/task.errors";
import {
	AttachmentAccessDeniedError,
	AttachmentAlreadyDeletedError,
	AttachmentFileMissingError,
	AttachmentFileTooLargeError,
	AttachmentInvalidFileNameError,
	AttachmentNotFoundError,
	AttachmentStorageError,
	AttachmentUnsupportedTypeError,
} from "./attachment.errors";
import {
	canAccessProjectAttachments,
	canUploadAttachment,
} from "./attachment.policy";
import {
	detectAttachmentMimeType,
	sanitizeAttachmentFileName,
} from "./attachment.schema";
import type {
	AttachmentDownload,
	AttachmentListQuery,
	AttachmentListResponse,
	AttachmentRecord,
	AttachmentResponse,
	AttachmentUploader,
	UploadedFileSource,
} from "./attachment.types";
import { localStorageProvider } from "./storage/local.storage";
import type { StorageProvider } from "./storage/storage.interface";

type ProjectRow = Omit<Models.public_Projects, "members" | "tasks">;

type TaskRow = Omit<
	Models.public_Tasks,
	| "assignedTo"
	| "attachments"
	| "auditLogs"
	| "dependencies"
	| "dependents"
	| "project"
>;

async function findVisibleProject(
	projectId: string,
): Promise<ProjectRow | null> {
	return db.orm.public.Projects.where((project) => project.id.eq(projectId))
		.where((project) => project.deletedAt.isNull())
		.first();
}

async function loadMemberIds(projectId: string): Promise<string[]> {
	const members = await db.orm.public.ProjectMembers.where((member) =>
		member.projectId.eq(projectId),
	)
		.select("userId")
		.all();
	return members.map((member) => member.userId);
}

function toProjectContext(
	project: Pick<ProjectRow, "id" | "status">,
	memberIds: readonly string[],
): ProjectAuthorizationContext {
	return {
		id: project.id,
		status: project.status,
		memberships: memberIds.map((userId) => ({ userId })),
	};
}

async function requireAccessibleProject(
	user: UserContext,
	projectId: string,
): Promise<ProjectRow> {
	const project = await findVisibleProject(projectId);
	if (!project) {
		throw new ProjectNotFoundError();
	}

	const memberIds = await loadMemberIds(project.id);
	if (
		!canAccessProjectAttachments(user, toProjectContext(project, memberIds))
	) {
		throw new AttachmentAccessDeniedError();
	}

	return project;
}

async function requireTask(
	projectId: string,
	taskId: string,
): Promise<TaskRow> {
	const task = await db.orm.public.Tasks.where((row) => row.id.eq(taskId))
		.where((row) => row.projectId.eq(projectId))
		.where((row) => row.deletedAt.isNull())
		.first();
	if (!task) {
		throw new TaskNotFoundError();
	}
	return task;
}

async function findAttachment(
	taskId: string,
	attachmentId: string,
): Promise<AttachmentRecord | null> {
	return db.orm.public.Attachments.where((row) => row.id.eq(attachmentId))
		.where((row) => row.taskId.eq(taskId))
		.first();
}

async function loadUploaderNames(
	userIds: readonly string[],
): Promise<Map<string, string>> {
	const uniqueIds = [...new Set(userIds)];
	if (uniqueIds.length === 0) {
		return new Map();
	}
	const users = await db.orm.public.Users.where((user) =>
		user.id.in([...uniqueIds]),
	)
		.select("id", "name")
		.all();
	return new Map(users.map((user) => [user.id, user.name]));
}

function toAttachmentResponse(
	attachment: AttachmentRecord,
	uploader: AttachmentUploader,
): AttachmentResponse {
	return {
		id: attachment.id,
		taskId: attachment.taskId,
		fileName: attachment.fileName,
		mimeType: attachment.mimeType,
		fileSize: attachment.fileSize,
		createdAt: attachment.createdAt,
		uploadedBy: uploader,
	};
}

function toPagination(
	page: number,
	limit: number,
	total: number,
): AttachmentListResponse["pagination"] {
	return {
		page,
		limit,
		total,
		totalPages: Math.ceil(total / limit),
	};
}

export function createAttachmentService(
	storage: StorageProvider = localStorageProvider,
) {
	async function uploadAttachment(
		user: UserContext,
		projectId: string,
		taskId: string,
		file: UploadedFileSource | null,
	): Promise<AttachmentResponse> {
		if (!canUploadAttachment(user)) {
			throw new AttachmentAccessDeniedError(
				"You do not have permission to upload attachments",
			);
		}

		const project = await requireAccessibleProject(user, projectId);
		const task = await requireTask(project.id, taskId);

		if (file === null || file === undefined) {
			throw new AttachmentFileMissingError();
		}

		const fileName = sanitizeAttachmentFileName(file.name);
		if (fileName === null) {
			throw new AttachmentInvalidFileNameError();
		}

		const maxSizeBytes = env.MAX_UPLOAD_SIZE_MB * 1024 * 1024;
		if (!Number.isSafeInteger(file.size) || file.size > maxSizeBytes) {
			throw new AttachmentFileTooLargeError(maxSizeBytes);
		}

		const bytes = await file.bytes();

		const mimeType = detectAttachmentMimeType(bytes, file.type);
		if (mimeType === null) {
			throw new AttachmentUnsupportedTypeError();
		}

		const storageKey = `tasks/${task.id}/${randomUUID()}`;

		try {
			await storage.upload({ key: storageKey, bytes });
		} catch {
			throw new AttachmentStorageError("Failed to store the attachment file");
		}

		try {
			const record = await db.orm.public.Attachments.create({
				taskId: task.id,
				uploadedById: user.id,
				fileName: toVarchar<255>(fileName),
				storageKey: toVarchar<255>(storageKey),
				mimeType: toVarchar<100>(mimeType),
				fileSize: bytes.byteLength,
			});

			const uploader = await db.orm.public.Users.first({ id: user.id });

			return toAttachmentResponse(record, {
				id: user.id,
				name: uploader?.name ?? "",
			});
		} catch (error) {
			try {
				await storage.delete(storageKey);
			} catch {
				// best-effort cleanup of the orphaned storage object
			}
			throw error;
		}
	}

	async function listAttachments(
		user: UserContext,
		projectId: string,
		taskId: string,
		query: AttachmentListQuery,
	): Promise<AttachmentListResponse> {
		const project = await requireAccessibleProject(user, projectId);
		const task = await requireTask(project.id, taskId);

		const page = query.page;
		const limit = query.limit;

		let collection = db.orm.public.Attachments.where((row) =>
			row.taskId.eq(task.id),
		).where((row) => row.deletedAt.isNull());

		if (query.mimeType !== undefined) {
			const mimeType = query.mimeType;
			collection = collection.where((row) =>
				row.mimeType.eq(toVarchar<100>(mimeType)),
			);
		}

		const countResult = await collection.aggregate((aggregate) => ({
			total: aggregate.count(),
		}));
		const attachments = await collection
			.orderBy((row) => row.createdAt.desc())
			.limit(limit)
			.offset((page - 1) * limit)
			.all();

		const uploaderNames = await loadUploaderNames(
			attachments.map((attachment) => attachment.uploadedById),
		);

		return {
			attachments: attachments.map((attachment) =>
				toAttachmentResponse(attachment, {
					id: attachment.uploadedById,
					name: uploaderNames.get(attachment.uploadedById) ?? "",
				}),
			),
			pagination: toPagination(page, limit, countResult.total),
		};
	}

	async function getAttachmentDownload(
		user: UserContext,
		projectId: string,
		taskId: string,
		attachmentId: string,
	): Promise<AttachmentDownload> {
		const project = await requireAccessibleProject(user, projectId);
		const task = await requireTask(project.id, taskId);

		const attachment = await findAttachment(task.id, attachmentId);
		if (attachment === null || attachment.deletedAt !== null) {
			throw new AttachmentNotFoundError();
		}

		const bytes = await storage.get(attachment.storageKey);
		if (bytes === null) {
			throw new AttachmentStorageError("The stored file is missing");
		}

		const uploaderName =
			(await loadUploaderNames([attachment.uploadedById])).get(
				attachment.uploadedById,
			) ?? "";

		return {
			attachment: toAttachmentResponse(attachment, {
				id: attachment.uploadedById,
				name: uploaderName,
			}),
			bytes,
		};
	}

	async function softDeleteAttachment(
		user: UserContext,
		projectId: string,
		taskId: string,
		attachmentId: string,
	): Promise<void> {
		const project = await requireAccessibleProject(user, projectId);
		const task = await requireTask(project.id, taskId);

		const attachment = await findAttachment(task.id, attachmentId);
		if (attachment === null) {
			throw new AttachmentNotFoundError();
		}
		if (attachment.deletedAt !== null) {
			throw new AttachmentAlreadyDeletedError();
		}

		const result = await db.orm.public.Attachments.where((row) =>
			row.id.eq(attachment.id),
		)
			.where((row) => row.taskId.eq(task.id))
			.where((row) => row.deletedAt.isNull())
			.update({ deletedAt: nowTimestamp() });
		if (!result) {
			throw new AttachmentAlreadyDeletedError();
		}
	}

	return {
		uploadAttachment,
		listAttachments,
		getAttachmentDownload,
		softDeleteAttachment,
	};
}

export const attachmentService = createAttachmentService();
