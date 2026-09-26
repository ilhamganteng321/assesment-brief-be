# Backend — Project Management API

Hono + TypeScript + PostgreSQL (Prisma 8). This service is the **authoritative
enforcement layer**: authentication, authorization, state transitions,
dependencies, concurrency control, auditability and tenant isolation are all
decided here. The Next.js frontend only makes the experience pleasant; every
rule below is re-checked on the server for every single request.

---

## Quick start

```bash
bun install
cp .env.example .env      # then fill in DATABASE_URL and JWT_SECRET
bunx prisma db migrate    # apply the migrations
bun run seed              # demo project, accounts, tasks, audit history
bun run dev               # http://localhost:3000
```

Interactive API reference: <http://localhost:3000/docs> (Scalar, served with a
relaxed CSP because it loads its own bundle; the OpenAPI document itself is at
`/openapi.json`).

### Environment

| Variable | Required | Notes |
| --- | --- | --- |
| `DATABASE_URL` | yes | PostgreSQL connection string |
| `JWT_SECRET` | yes | At least 32 characters in production |
| `PORT` | no | Defaults to `3000` |
| `NODE_ENV` | no | `development` \| `test` \| `production` |
| `FRONTEND_URL` / `CORS_ORIGIN` | production | Comma-separated allowed origins. Each must be a bare origin (`https://app.example.com`) with no path, query, fragment or credentials; anything else is refused at boot. Required in production |
| `API_BASE_URL` | no | Server URL advertised in the OpenAPI document |
| `JWT_EXPIRES_IN` | no | Defaults to `1d` |
| `MAX_UPLOAD_SIZE_MB` | no | Defaults to `10` |
| `STORAGE_PROVIDER` | no | `local` |
| `STORAGE_LOCAL_DIR` | no | Defaults to `./storage/uploads` |
| `RATE_LIMIT_MAX` / `RATE_LIMIT_WINDOW_SECONDS` | no | General limiter |
| `AUTH_RATE_LIMIT` / `AUTH_RATE_WINDOW_SECONDS` | no | Stricter limiter on `/auth/login` and `/auth/register` |

`src/config/env.ts` validates the environment at boot and exits with a readable
message rather than starting half-configured. No secret is ever committed:
`.env` is gitignored and `.env.example` holds placeholders only.

---

## Demo accounts

Created by `bun run seed`. These are published assessment fixtures, not
credentials for anything real.

| Role | Email | Password |
| --- | --- | --- |
| Product Manager | `pm@aurora.demo` | `DemoPass#2026` |
| Internal — UI/UX | `uiux@aurora.demo` | `DemoPass#2026` |
| Internal — Frontend | `frontend@aurora.demo` | `DemoPass#2026` |
| Internal — Backend | `backend@aurora.demo` | `DemoPass#2026` |
| Client Guest | `client@aurora.demo` | `DemoPass#2026` |

To provision the PM as your own login instead:

```bash
bun run seed you@example.com 'YourPassword#1'
```

The seed is idempotent — re-running it never duplicates data and never
overwrites state you changed while reviewing.

Verify at any time that every documented account still signs in:

```bash
bun run verify:seed-logins
```

---

## Architecture

```
routes/          thin HTTP layer: route table, nothing else
  ↓
*.service.ts     business rules, transactions, audit writes
  ↓
*.policy.ts      pure role/attribute decisions (no I/O)
  ↓
prisma/db.ts     the only module that touches the database
```

Cross-cutting concerns sit alongside rather than inside that chain:

| Concern | Where |
| --- | --- |
| Authentication | `src/middleware/auth.ts` |
| Authorization / ABAC | `src/modules/authorization/` |
| Validation | `*.schema.ts` (Zod, strict) |
| Errors | `src/lib/http-error.ts`, `src/middleware/error-handler.ts` |
| Response envelope | `src/lib/response.ts` |
| Audit trail | `src/modules/audit/` |
| Rate limiting | `src/middleware/rate-limit.ts` |
| Security headers, CORS | `src/middleware/security.ts`, `src/middleware/cors.ts` |

Every route goes through a service. No route touches Prisma directly, so a
business rule cannot be bypassed by calling an endpoint that forgot a check.

### Modules

`auth`, `projects`, `tasks`, `dependencies`, `attachments`, `audit`, `client`,
`authorization` — each with `*.routes.ts`, `*.service.ts`, `*.policy.ts`,
`*.schema.ts`, `*.errors.ts`, `*.types.ts` and, where the logic is pure enough
to test directly, a colocated `*.test.ts`.

---

## API surface

| Method | Path | Notes |
| --- | --- | --- |
| `POST` | `/auth/register` | Issues an **INTERNAL** account only |
| `POST` | `/auth/login` | |
| `POST` | `/auth/logout` | |
| `GET` | `/auth/me` | |
| `GET`/`POST` | `/projects` | List respects the caller's visibility |
| `GET`/`PATCH`/`DELETE` | `/projects/:projectId` | |
| `GET` | `/projects/:projectId/metrics` | |
| `GET` | `/projects/:projectId/activity` | |
| `GET`/`POST` | `/projects/:projectId/members` | |
| `DELETE` | `/projects/:projectId/members/:userId` | |
| `GET`/`POST` | `/projects/:projectId/tasks` | |
| `GET`/`PATCH`/`DELETE` | `/projects/:projectId/tasks/:taskId` | |
| `GET`/`POST` | `/tasks`, `/tasks/:taskId` | Flat equivalent of the above |
| `GET`/`POST` | `/projects/:projectId/tasks/:taskId/dependencies` | |
| `DELETE` | `.../dependencies/:dependencyTaskId` | |
| `GET` | `/projects/:projectId/tasks/:taskId/audit-logs` | Read-only; writes are refused |
| `GET`/`POST` | `/projects/:projectId/tasks/:taskId/attachments` | |
| `GET`/`DELETE` | `.../attachments/:attachmentId` | |
| `GET` | `/client/dashboard` | The client guest's sanitised view |
| `GET` | `/client/projects/:projectId/tasks[/:taskId]` | |
| `GET` | `/health`, `/health/live`, `/health/ready` | Unauthenticated. `/ready` probes the database and returns `503` when it cannot be reached |

The flat `/tasks` surface and the project-scoped one call the same services, so
they cannot drift apart in what they allow.

### Response envelope

Every response, success or failure, uses one shape:

```jsonc
// success
{ "success": true, "data": { /* ... */ } }

// failure
{ "success": false, "error": { "code": "CONCURRENT_MODIFICATION", "message": "…", "requestId": "…" } }
```

Error bodies never carry a stack trace, SQL, or driver detail. A 409 additionally
returns `expectedVersion`, `currentVersion` and `latestTask` so the client can
reconcile without a second round trip.

---

## Business rules worth knowing

**RBAC.** Only a PM creates or deletes tasks, assigns work, edits a description,
changes priority/department/client-visibility, or manages dependencies. An
internal user may only edit a task assigned to them. A client guest never writes.

**Completion belongs to the assignee.** A PM may start, reassign and re-prioritise
a task, but moving somebody else's task from `IN_PROGRESS` to `DONE` is refused —
the person doing the work closes it.

**State transitions.** `TODO → IN_PROGRESS → DONE`, with `BLOCKED` as a derived,
server-computed state. A transition into `IN_PROGRESS` is refused while any
prerequisite is unfinished, and the refusal names them.

**Dependencies are acyclic.** Self-dependencies, duplicates, cross-project edges
and any edge that would close a cycle are rejected. The check runs inside the
same transaction that inserts the edge, so two concurrent requests cannot both
succeed.

**Optimistic locking.** Every task carries a `version`. A mutation must send the
version it read; a mismatch is `409 CONCURRENT_MODIFICATION` and the write is
discarded whole rather than merged. Deletes participate in the same scheme.

**Soft deletes.** A deleted task leaves every normal read path but stays in the
database, and a deleted prerequisite still blocks its dependents.

**Audit trail.** Every change to a tracked field writes an immutable row (user,
timestamp, column, old value, new value) in the same transaction as the change
itself — so a rejected write leaves no trace. No verb can alter or erase one.

**Client isolation.** A client guest reads only `/client/*`, which returns a
narrowed projection. A project they cannot reach is reported exactly as a
project that does not exist, and counts in a response describe only what the
response actually contains.

---

## Query contract

`GET /projects/:projectId/tasks` and the audit feed accept:

```
?filters={"status":"DONE","priority":"HIGH"}      equality, ANDed
&searchFilters={"title":"frontend"}                case-insensitive contains
&rangedFilters=[{"key":"createdAt","start":"…","end":"…"}]   inclusive
&page=1&rows=10
&orderKey=createdAt&orderRule=desc
```

`filters` also accepts an array for "any of": `{"status":["TODO","IN_PROGRESS"]}`.

Filter keys, searchable keys, range keys and `orderKey` are each an explicit
allow-list. A column outside it is a `400`, which is what keeps an arbitrary
expression out of the ORDER BY.

---

## Reviewer walkthroughs

The seed is arranged so both scenarios below work on a freshly seeded database
with no setup.

### 1. Dependencies, roles and isolation

The seeded project contains a diamond:

```
UI Design (Home & Checkout)   DONE     client-visible
Backend API Integration       TODO     client-visible
        └──────────┬──────────┘
           Frontend Slicing    BLOCKED  client-visible
QA & Testing                  IN_PROGRESS  client-visible
Deployment Prep               TODO     internal only
```

| Step | Sign in as | Do | Observe |
| --- | --- | --- | --- |
| 1 | `pm@aurora.demo` | Open the project | The PM sees all five tasks, including the internal-only one |
| 2 | `pm@aurora.demo` | Open **Frontend Slicing** | Listed as blocked, naming both open prerequisites |
| 3 | `backend@aurora.demo` | Try to start **Frontend Slicing** | Refused — the prerequisite is unfinished, and the error names it |
| 4 | `pm@aurora.demo` | Try to mark **QA & Testing** (in progress, someone else's) `DONE` | Refused — only the assignee may close a task |
| 5 | `backend@aurora.demo` | Start, then complete **Backend API Integration** | Two transitions; each writes an audit row |
| 6 | `frontend@aurora.demo` | Open **Frontend Slicing** | Now unblocked; start it |
| 7 | `frontend@aurora.demo` | Attach a file to it | Upload accepted, content type and size validated server-side |
| 8 | anyone internal | Open the activity timeline | Every change above, with actor, column, old and new value |
| 9 | `client@aurora.demo` | Sign in | Redirected to the client dashboard; only client-visible tasks appear, **Deployment Prep** is absent, and a direct request for it is indistinguishable from a task that does not exist |

Step 3 works through the API regardless of what the UI shows; the button is
hidden *and* the endpoint refuses.

### 2. Optimistic locking

1. Open the same task in two browser windows.
2. In window A, edit the description and save. The version advances.
3. In window B — still holding the old version — save an edit.
4. The request is rejected with `409 CONCURRENT_MODIFICATION`. The response
   carries `expectedVersion`, `currentVersion` and `latestTask`, and the UI
   refetches instead of overwriting.
5. Window A's value is intact; window B's change was discarded whole, not merged.

The same happens when two people change *different* fields: the write is
whole-row, so exactly one of them survives and the other is told to retry. The
loser leaves no audit row, because the audit write shares the transaction.

---

## Testing

```bash
bun test              # unit tests, no database needed
bun run test:suites   # the DB-backed suites (see below)
bun run test:integration  # end-to-end walkthrough, 220 checks
bun run typecheck
bun run lint
```

### `tests/` — behaviour suites against a real database

```
tests/
├── auth/          tokens, expiry, identity from claims only
├── permissions/   RBAC and ABAC per role
├── isolation/     client guest tenant isolation
├── state/         the task transition matrix, dependency gating
├── dependencies/  self, duplicate, cyclic, cross-project
├── concurrency/   optimistic locking and 409 handling
├── audit/         audit trail, immutability, soft delete
├── attachments/   upload/download authorization and content validation
├── query/         filters, search, ranges, pagination, sorting, combined
├── validation/    Zod payloads and mass assignment
└── helpers/       the shared harness
```

These drive the real application through `app.request()` against a live
PostgreSQL. Nothing re-implements a business rule, so a rule can only pass if
the deployed service enforces it. Direct database access is confined to building
the PM and client actors (which `/auth/register` deliberately refuses to create)
and reading rows back to prove what was actually persisted.

They need a reachable database. If one is not available the suite **fails
loudly** rather than passing on empty fixtures, and the message says which check
failed and what to do about it.

### From a clean database

```bash
bun run verify:clean-database
```

Creates a scratch database, applies every migration from nothing, seeds it, signs
in as every documented demo account, typechecks against the resulting schema, and
drops the scratch database again. The source database is never touched. This is
the check to run before assuming the migrations work for a reviewer.

---

## Deployment

`railway.toml` and `DEPLOYMENT.md` cover the deployment path. The two things that
must be set in production are `FRONTEND_URL` (CORS refuses to start without it)
and a `JWT_SECRET` of at least 32 characters; the app exits at boot naming any
variable that is missing or too weak.
