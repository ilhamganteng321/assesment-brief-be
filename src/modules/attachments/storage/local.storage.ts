import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { env } from "../../../config/env";
import type { StorageProvider } from "./storage.interface";

const INVALID_KEY_MESSAGE = "Invalid storage key";

function assertSafeKey(key: string): string[] {
	if (key.length === 0 || key.startsWith("/") || /^[a-zA-Z]:/.test(key)) {
		throw new Error(INVALID_KEY_MESSAGE);
	}

	const parts = key.split("/");
	if (
		parts.some((part) => part.length === 0 || part === "." || part === "..")
	) {
		throw new Error(INVALID_KEY_MESSAGE);
	}

	return parts;
}

export class LocalStorageProvider implements StorageProvider {
	constructor(private readonly rootDir: string) {}

	private keyToFilePath(key: string): string {
		const parts = assertSafeKey(key);
		const fullPath = resolve(this.rootDir, ...parts);
		const relativePath = relative(this.rootDir, fullPath);
		if (relativePath.startsWith("..") || isAbsolute(relativePath)) {
			throw new Error(INVALID_KEY_MESSAGE);
		}
		return fullPath;
	}

	async upload(request: { key: string; bytes: Uint8Array }): Promise<void> {
		const filePath = this.keyToFilePath(request.key);
		await mkdir(dirname(filePath), { recursive: true });
		await writeFile(filePath, request.bytes);
	}

	async get(key: string): Promise<Uint8Array | null> {
		const filePath = this.keyToFilePath(key);
		try {
			return await readFile(filePath);
		} catch (error) {
			if (
				error instanceof Error &&
				"code" in error &&
				error.code === "ENOENT"
			) {
				return null;
			}
			throw error;
		}
	}

	async delete(key: string): Promise<void> {
		const filePath = this.keyToFilePath(key);
		await rm(filePath, { force: true });
	}
}

export const localStorageProvider = new LocalStorageProvider(
	resolve(process.cwd(), env.STORAGE_LOCAL_DIR),
);
