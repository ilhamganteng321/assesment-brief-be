import { db } from "../src/prisma/db";

/**
 * Deletes the rows the integration suites leave behind.
 *
 * Not a general cleaner: it targets the `It ` / `it-` naming the fixtures use, so
 * it cannot touch seeded demo data. Exists to make "how much did that suite leak"
 * a question with a number attached instead of a guess.
 *
 * Order matters. Audit rows reference both a task and a user with `ON DELETE
 * RESTRICT`, so they go first — without that, deleting a user who ever changed a
 * task raises a constraint violation and the row stays, which is exactly the
 * failure this script exists to diagnose.
 */
const TEST_NAME = "It %";
const TEST_EMAIL = "%@example.local";

const before = await db.orm.public.Users.aggregate((a) => ({ n: a.count() }));

// Every audit row belongs to the fixtures: the seeded demo projects have none.
await db.orm.public.AuditLogs.where((row) => row.taskId.isNotNull()).delete();
await db.orm.public.Tasks.where((t) => t.title.ilike(TEST_NAME)).delete();
await db.orm.public.Projects.where((p) => p.name.ilike(TEST_NAME)).delete();
await db.orm.public.Users.where((u) => u.name.ilike(TEST_NAME)).delete();
await db.orm.public.Users.where((u) => u.email.ilike(TEST_EMAIL)).delete();

const users = await db.orm.public.Users.aggregate((a) => ({ n: a.count() }));
const projects = await db.orm.public.Projects.aggregate((a) => ({ n: a.count() }));
const tasks = await db.orm.public.Tasks.aggregate((a) => ({ n: a.count() }));
const members = await db.orm.public.ProjectMembers.aggregate((a) => ({ n: a.count() }));
console.log(
	`CLEANED users ${String(before.n)} -> ${String(users.n)}, projects=${String(projects.n)} tasks=${String(tasks.n)} members=${String(members.n)}`,
);
