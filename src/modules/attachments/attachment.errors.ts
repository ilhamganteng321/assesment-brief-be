import { HttpError } from "../../lib/http-error";

export class AttachmentNotFoundError extends HttpError {
	constructor() {
		super(404, "ATTACHMENT_NOT_FOUND", "Attachment not found");
	}
}

export class AttachmentAccessDeniedError extends HttpError {
	constructor(
		message = "You do not have permission to access attachments in this project",
	) {
		super(403, "ATTACHMENT_ACCESS_DENIED", message);
	}
}

export class AttachmentFileMissingError extends HttpError {
	constructor() {
		super(400, "ATTACHMENT_FILE_REQUIRED", "A file must be provided");
	}
}

export class AttachmentInvalidFileNameError extends HttpError {
	constructor() {
		super(400, "ATTACHMENT_INVALID_FILE_NAME", "The file name is invalid");
	}
}

export class AttachmentFileTooLargeError extends HttpError {
	constructor(maxSizeBytes: number) {
		super(413, "ATTACHMENT_FILE_TOO_LARGE", "The file is too large", {
			maxSizeBytes,
		});
	}
}

export class AttachmentUnsupportedTypeError extends HttpError {
	constructor() {
		super(415, "ATTACHMENT_UNSUPPORTED_TYPE", "The file type is not supported");
	}
}

export class AttachmentAlreadyDeletedError extends HttpError {
	constructor() {
		super(
			409,
			"ATTACHMENT_ALREADY_DELETED",
			"This attachment has already been deleted",
		);
	}
}

export class AttachmentStorageError extends HttpError {
	constructor(message = "Failed to store the attachment") {
		super(500, "ATTACHMENT_STORAGE_ERROR", message);
	}
}

/**
 * The row is there but the bytes behind it are not.
 *
 * Not a server fault, so deliberately not a 500: the local storage provider is
 * the only implementation, and its directory does not survive a redeploy on a
 * platform with an ephemeral filesystem, which leaves attachment rows pointing
 * at files that no longer exist. Reporting that as `ATTACHMENT_STORAGE_ERROR`
 * would read as "the API is broken" and send a reviewer looking at the wrong
 * layer, and it would page whoever is on call for a deployment artefact.
 */
export class AttachmentContentMissingError extends HttpError {
	constructor() {
		super(
			404,
			"ATTACHMENT_CONTENT_MISSING",
			"The stored file for this attachment is no longer available",
		);
	}
}
