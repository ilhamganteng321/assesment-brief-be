import "dotenv/config";

// Must precede the ORM: this installs the `Temporal` global that the
// `timestamp` codec requires, and the codec throws on the first decoded row
// without it. See ./temporal for why the app cannot rely on the runtime.
import "./temporal";
import postgres from "@prisma/orm-postgres/runtime";
import type { Contract } from "./contract.d";
import contractJson from "./contract.json" with { type: "json" };

export const db = postgres<Contract>({
  contractJson,
  url: process.env["DATABASE_URL"]!,
});
