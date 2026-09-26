import type { ProjectRecord, ProjectResponse } from "./project.types";

function toIsoString(value: unknown): string {
	if (typeof value === "string") {
		return value;
	}

	if (value instanceof Date) {
		return value.toISOString();
	}

	if (
		typeof value === "object" &&
		value !== null &&
		"toString" in value &&
		typeof value.toString === "function"
	) {
		return value.toString();
	}

	return String(value);
}

export function toProjectResponse(project: ProjectRecord): ProjectResponse {
	return {
		id: project.id,
		name: project.name,
		description: project.description,
		clientName: project.clientName,
		status: project.status,
		createdAt: toIsoString(project.createdAt),
		updatedAt: toIsoString(project.updatedAt),
	};
}
