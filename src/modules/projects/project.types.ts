import type { Models } from "../../prisma/contract";

export type ProjectRecord = Omit<Models.public_Projects, "members" | "tasks">;

export type ProjectMemberRecord = Omit<
	Models.public_ProjectMembers,
	"project" | "user"
>;

export type ProjectMemberWithUser = ProjectMemberRecord & {
	user: {
		id: Models.public_Users["id"];
		name: Models.public_Users["name"];
		email: Models.public_Users["email"];
		department: Models.public_Users["department"];
	};
};

export type Pagination = {
	page: number;
	limit: number;
	total: number;
	totalPages: number;
};

/**
 * Allow-listed project response. Database rows are never returned directly, so a
 * new column can never leak into the API without a deliberate decision here.
 */
export type ProjectResponse = {
	id: string;
	name: string;
	description: string | null;
	clientName: string | null;
	status: ProjectRecord["status"];
	createdAt: string;
	updatedAt: string;
};

export type ProjectMemberResponse = {
	id: string;
	projectId: string;
	userId: string;
	createdAt: string;
	user: {
		id: string;
		name: string;
		email: string;
		department: Models.public_Users["department"];
	};
};

export type ProjectListResponse = {
	projects: ProjectResponse[];
	pagination: Pagination;
};
