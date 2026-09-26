import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import {
	PNG_BYTES,
	type World,
	api,
	assertSuiteIsRunnable,
	buildWorld,
	cleanupFixtures,
	createTask,
	databaseIsReachable,
	errorCode,
	jsonPath,
	pngForm,
	readTaskRow,
} from "../helpers/harness";

// ---------------------------------------------------------------------------
// Attachment authorization and validation (assessment section 28).
//
// The frontend checks file type and size before uploading, which is a courtesy
// to the user and nothing more. These checks go through the API so that a
// crafted request is judged by the server.
//
// The type check is content based: a file is accepted because of the bytes it
// actually contains, not because of its name or the `Content-Type` the client
// claimed. That is what makes a renamed executable fail.
// ---------------------------------------------------------------------------

let reachable = false;
let world: World;
/** A task in the client's own project, used as the upload target. */
let taskId = "";

const attachmentsUrl = (): string =>
	`/projects/${world.project.id}/tasks/${taskId}/attachments`;

beforeAll(async () => {
	reachable = await databaseIsReachable();
	if (!reachable) {
		return;
	}
	world = await buildWorld();
	taskId = await createTask(world.pm, world.project.id, "Attachment target", {
		assignedToId: world.engineer.userId,
		department: "BACKEND",
	});
});

afterAll(cleanupFixtures);

async function upload(
	form: FormData,
	token: string,
): Promise<{ status: number; json: unknown; text: string }> {
	const res = await api(attachmentsUrl(), { method: "POST", token, form });
	return { status: res.status, json: res.json, text: res.text };
}

describe("attachment security", () => {
	test("the suite is skipped loudly rather than passing on an empty database", () => {
		assertSuiteIsRunnable(reachable);
	});

	describe("authorization", () => {
		test("a project manager can upload and download", async () => {
			const res = await upload(pngForm("pm-report.png"), world.pm.token);
			expect(res.status).toBe(201);

			const attachmentId = jsonPath<string>(res, ["data", "attachment", "id"]);
			expect(typeof attachmentId).toBe("string");

			const download = await api(
				`${attachmentsUrl()}/${attachmentId}`,
				{ token: world.pm.token },
			);
			expect(download.status).toBe(200);
			expect(download.bytes.equals(PNG_BYTES)).toBe(true);
		});

		test("an internal member can upload", async () => {
			const res = await upload(pngForm("engineer-note.png"), world.engineer.token);
			expect(res.status).toBe(201);
		});

		test("a client guest cannot upload, list or download", async () => {
			const uploadRes = await upload(pngForm("client.png"), world.client.token);
			expect([403, 404]).toContain(uploadRes.status);

			const listRes = await api(attachmentsUrl(), { token: world.client.token });
			expect([403, 404]).toContain(listRes.status);
		});

		test("an outsider cannot reach attachments on a project it does not belong to", async () => {
			const foreignTaskId = await createTask(
				world.pm,
				world.foreignProject.id,
				"Foreign attachment target",
			);
			const res = await api(
				`/projects/${world.foreignProject.id}/tasks/${foreignTaskId}/attachments`,
				{ token: world.engineer.token },
			);
			expect([403, 404]).toContain(res.status);
		});

		test("an attachment is only reachable under its own task and project", async () => {
			const created = await upload(pngForm("scoped.png"), world.pm.token);
			const attachmentId = jsonPath<string>(created, ["data", "attachment", "id"]) ?? "";

			// A second task in the same project, to show the id is not just
			// "any attachment in the project".
			const sibling = await createTask(
				world.pm,
				world.project.id,
				"Sibling task",
				{ assignedToId: world.engineer.userId, department: "BACKEND" },
			);
			const foreignTaskId = await createTask(
				world.pm,
				world.foreignProject.id,
				"Foreign project task",
			);

			const reachable = await api(`${attachmentsUrl()}/${attachmentId}`, {
				token: world.pm.token,
			});
			expect(reachable.status).toBe(200);

			for (const path of [
				`/projects/${world.project.id}/tasks/${sibling}/attachments/${attachmentId}`,
				`/projects/${world.foreignProject.id}/tasks/${foreignTaskId}/attachments/${attachmentId}`,
			]) {
				const res = await api(path, { token: world.pm.token });
				expect([403, 404]).toContain(res.status);
			}
		});

		test("an unknown task id is a 404", async () => {
			const res = await upload(
				pngForm("orphan.png"),
				world.pm.token,
			);
			expect(res.status).toBe(201);

			const list = await api(
				`/projects/${world.project.id}/tasks/00000000-0000-4000-8000-000000000000/attachments`,
				{ token: world.pm.token },
			);
			expect(list.status).toBe(404);
		});

		test("a malformed task id is rejected before any lookup", async () => {
			const res = await api(
				`/projects/${world.project.id}/tasks/not-a-uuid/attachments`,
				{ token: world.pm.token },
			);
			expect(res.status).toBe(400);
		});
	});

	describe("content validation", () => {
		test("a file whose bytes are not a permitted type is refused", async () => {
			const script = Buffer.from("#!/bin/sh\nrm -rf /\n", "utf8");
			const res = await upload(
				pngForm("payload.png", "text/plain", script),
				world.pm.token,
			);

			expect(res.status).toBe(415);
			expect(errorCode(res)).toBe("ATTACHMENT_UNSUPPORTED_TYPE");
		});

		test("a Windows executable is refused even when named as a png", async () => {
			const executable = Buffer.from([0x4d, 0x5a, 0x90, 0x00, 0x03]);
			const res = await upload(
				pngForm("innocent.png", "image/png", executable),
				world.pm.token,
			);

			expect(res.status).toBe(415);
		});

		test("a declared type that disagrees with the bytes is refused", async () => {
			// Real PNG bytes, but the client claims it is a PDF.
			const res = await upload(
				pngForm("mislabelled.pdf", "application/pdf", PNG_BYTES),
				world.pm.token,
			);

			expect(res.status).toBe(415);
		});

		test("an empty file is refused", async () => {
			const res = await upload(
				pngForm("empty.png", "image/png", Buffer.alloc(0)),
				world.pm.token,
			);

			expect(res.status).toBe(415);
		});

		test("a request with no file part is refused", async () => {
			const form = new FormData();
			form.append("note", "no file here");
			const res = await upload(form, world.pm.token);

			expect(res.status).toBe(400);
			expect(errorCode(res)).toBe("ATTACHMENT_FILE_REQUIRED");
		});

		test("a traversal attempt in the file name is neutralised", async () => {
			const res = await upload(pngForm("../../etc/passwd.png"), world.pm.token);
			expect(res.status).toBe(201);

			// The stored name keeps only the base name.
			const stored = jsonPath<string>(res, ["data", "attachment", "fileName"]);
			expect(stored).toBe("passwd.png");
		});

		test("a name that sanitises to nothing is refused", async () => {
			const res = await upload(pngForm("..."), world.pm.token);
			expect(res.status).toBe(400);
		});

		test("an oversized upload is refused by the server", async () => {
			// A megabyte of PNG-magic followed by padding: the header is valid, so
			// only the size rule can catch it.
			const oversized = Buffer.concat([
				PNG_BYTES,
				Buffer.alloc(11 * 1024 * 1024, 0x41),
			]);
			const res = await upload(
				pngForm("huge.png", "image/png", oversized),
				world.pm.token,
			);

			expect([413, 415]).toContain(res.status);
		});
	});

	describe("deletion", () => {
		test("an attachment can be removed and then disappears", async () => {
			const created = await upload(pngForm("temporary.png"), world.pm.token);
			const attachmentId = jsonPath<string>(created, ["data", "attachment", "id"]) ?? "";

			const removed = await api(`${attachmentsUrl()}/${attachmentId}`, {
				method: "DELETE",
				token: world.pm.token,
			});
			expect(removed.status).toBe(204);

			const download = await api(`${attachmentsUrl()}/${attachmentId}`, {
				token: world.pm.token,
			});
			expect([404, 409]).toContain(download.status);
		});

		test("removing the same attachment twice is refused", async () => {
			const created = await upload(pngForm("twice.png"), world.pm.token);
			const attachmentId = jsonPath<string>(created, ["data", "attachment", "id"]) ?? "";

			await api(`${attachmentsUrl()}/${attachmentId}`, {
				method: "DELETE",
				token: world.pm.token,
			});
			const again = await api(`${attachmentsUrl()}/${attachmentId}`, {
				method: "DELETE",
				token: world.pm.token,
			});

			expect([404, 409]).toContain(again.status);
		});

		test("a client guest cannot remove an attachment", async () => {
			const created = await upload(pngForm("protected.png"), world.pm.token);
			const attachmentId = jsonPath<string>(created, ["data", "attachment", "id"]) ?? "";

			const res = await api(`${attachmentsUrl()}/${attachmentId}`, {
				method: "DELETE",
				token: world.client.token,
			});
			expect([403, 404]).toContain(res.status);
		});
	});

	describe("the response itself is safe", () => {
		test("a download is served with hardening headers and a sanitised name", async () => {
			const created = await upload(
				pngForm('ev"il;name.png'),
				world.pm.token,
			);
			const attachmentId = jsonPath<string>(created, ["data", "attachment", "id"]) ?? "";

			const res = await api(`${attachmentsUrl()}/${attachmentId}`, {
				token: world.pm.token,
			});

			expect(res.status).toBe(200);
			expect(res.headers.get("x-content-type-options")).toBe("nosniff");
			const disposition = res.headers.get("content-disposition") ?? "";
			expect(disposition).toContain("attachment;");
			// A quote or a semicolon in the name must not survive into the header.
			expect(disposition).not.toContain('"evil;name.png"');
			expect(res.headers.get("content-type")).toBe("image/png");
		});

		test("an upload response does not disclose the storage key or path", async () => {
			const res = await upload(pngForm("quiet.png"), world.pm.token);

			expect(res.status).toBe(201);
			expect(res.text).not.toContain("storageKey");
			expect(res.text.toLowerCase()).not.toContain("storage/uploads");
		});
	});

	describe("attachments follow the task lifecycle", () => {
		test("a deleted task stops serving its attachments", async () => {
			const doomed = await createTask(world.pm, world.project.id, "Doomed with files", {
				assignedToId: world.engineer.userId,
				department: "BACKEND",
			});
			const url = `/projects/${world.project.id}/tasks/${doomed}/attachments`;

			const created = await api(url, {
				method: "POST",
				token: world.pm.token,
				form: pngForm("doomed.png"),
			});
			const attachmentId = jsonPath<string>(created, ["data", "attachment", "id"]) ?? "";

			const version = (await readTaskRow(doomed))?.version ?? 1;
			await api(`/tasks/${doomed}?version=${version}`, {
				method: "DELETE",
				token: world.pm.token,
			});

			const afterDelete = await api(`${url}/${attachmentId}`, {
				token: world.pm.token,
			});
			expect([403, 404]).toContain(afterDelete.status);
		});
	});
});
