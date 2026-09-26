import type { Scalars } from "@prisma/orm-postgres/family-contract/types";
import type { Models } from "../../prisma/contract.d";

export type SafeUser = Pick<
	Scalars<Models.public_Users>,
	"id" | "name" | "email" | "role" | "department"
>;

export type AuthSession = {
	user: SafeUser;
	accessToken: string;
};
