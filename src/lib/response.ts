export type ApiSuccessResponse<T> = {
	success: true;
	data: T;
};

export type ApiErrorResponse = {
	success: false;
	error: {
		code: string;
		message: string;
		requestId?: string;
	};
};

export function successResponse<T>(data: T): ApiSuccessResponse<T> {
	return { success: true, data };
}

export function errorResponse(
	code: string,
	message: string,
	requestId?: string,
	details?: Record<string, unknown>,
): ApiErrorResponse {
	return {
		success: false,
		error: {
			code,
			message,
			...(requestId ? { requestId } : {}),
			...(details ?? {}),
		},
	};
}
