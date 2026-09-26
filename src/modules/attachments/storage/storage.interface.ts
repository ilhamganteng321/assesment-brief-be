export type StorageWriteRequest = {
	key: string;
	bytes: Uint8Array;
};

export interface StorageProvider {
	upload(request: StorageWriteRequest): Promise<void>;
	get(key: string): Promise<Uint8Array | null>;
	delete(key: string): Promise<void>;
}
