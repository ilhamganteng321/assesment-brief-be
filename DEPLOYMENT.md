# Deployment Runbook — Railway

Production-ready configuration for the Hono/Bun/Prisma 8 backend.
Target: deploy to Railway, reusing the current Neon PostgreSQL database.

## 0. What is already in the repo

| File | Role |
| --- | --- |
| `railway.toml` | Railway config: Nixpacks build, `bun run start`, pre-deploy migration hook, `/health` healthcheck, restart on failure |
| `src/config/env.ts` | Centralized zod env validation (fails fast; JWT_SECRET ≥ 32 in production; PORT default 3000; CORS_ORIGIN alias) |
| `src/middleware/cors.ts` | CORS allowlist from `FRONTEND_URL` + `CORS_ORIGIN` (never `*`) |
| `src/middleware/error-handler.ts` | Sanitized 500s; detailed stack only in logs |
| `src/index.ts` | `Bun.serve({ hostname: "0.0.0.0", port: env.PORT })` |
| `src/prisma/temporal.ts` | Installs a `Temporal` global; required by Prisma's `timestamp` codec on any runtime that does not ship one (see below) |
| `.env.example` | Documented env variables (safe to commit) |
| `migrations/app/` | 5 committed Prisma 8 migration packages |
| `prisma.config.ts` | Migration config; reads `DATABASE_URL` from env |

`/health`, `/health/live`, `/health/ready` are public; `/docs` and `/openapi.json`
are served in production.

### Runtime requirement: `Temporal`

Every `timestamp` column goes through Prisma's `pg/timestamp-temporal@1` codec,
which throws unless a `Temporal` global exists:

```
StructuredError: Codec 'pg/timestamp-temporal@1' cannot decode a value because
this runtime has no global Temporal implementation
```

Bun only exposes `Temporal` from 1.3 onwards and Node does not expose it at all,
so on an older Bun this surfaced as **every request failing, starting with
`POST /auth/login`** — which reads a user row, and therefore looks like an auth
fault rather than a missing runtime primitive. Check `bun --version` on the
deployed service if it appears.

`temporal-polyfill` is a runtime dependency and `src/prisma/temporal.ts` installs
it, but only when the runtime has nothing of its own, so a modern Bun keeps its
native implementation. The module is imported by both `src/prisma/db.ts` and
`src/prisma/scalars.ts`; keep those imports if either file is reorganised, or
timestamps will start failing to decode again.

## 1. Decisions made

- **Hosting:** Railway (Nixpacks + Bun runtime, no Dockerfile needed).
- **Database:** reuse the existing Neon Postgres already used for dev/seed.
  Because it is reused, the demo seed data **already exists** in production.
- **Credentials:** you are performing the deploy; this folder is not a git repository yet.

## 2. Push the code to GitHub

Railway imports a repo. From `D:\framework\hono\test\backend`:

```powershell
git init
git status          # verify only intended files; .env is ignored (see .gitignore)
git add .
git commit -m "feat: production-ready backend (env, cors, health, docs, seed, migrations)"
git branch -M main
git remote add origin https://github.com/<you>/<repo>.git
git push -u origin main
```

Convention: continue with [conventional commits](https://www.conventionalcommits.org/).
`.env` is ignored (`git check-ignore .env` → confirms `.env`); it is the only copy of real credentials.

## 3. Environment variables (Railway > your service > Variables)

Production must have (backend `env.ts` fails fast if missing/malformed):

| Variable | Value |
| --- | --- |
| `DATABASE_URL` | The current Neon PostgreSQL URL (reused DB) |
| `JWT_SECRET` | New random ≥ 32 chars — e.g. `openssl rand -hex 32`. Never reuse the dev secret |
| `NODE_ENV` | `production` |
| `PORT` | `3000` (Railway injects a port; leave unset or set to 3000) |
| `FRONTEND_URL` **or** `CORS_ORIGIN` | At least one required in production. The deployed Next.js frontend origin, e.g. `https://<frontend-domain>`. The two are aliases: set one, not both. Comma-separated for multiple |
| `API_BASE_URL` | The deployed backend URL, e.g. `https://<service>.up.railway.app` (drives OpenAPI `servers` + docs) |
| `JWT_EXPIRES_IN` | optional, default `1d` |
| `MAX_UPLOAD_SIZE_MB`, `STORAGE_PROVIDER`, `STORAGE_LOCAL_DIR` | optional, defaults apply |

Do **not** set: `DATABASE_URL` variants, migration flags, or anything secret in plaintext elsewhere.

### The CORS variables, concretely

`FRONTEND_URL` and `CORS_ORIGIN` are two names for the same setting, so **you only need one**:

```bash
FRONTEND_URL=https://your-frontend.up.railway.app
```

**Do not set the unused one to an empty string.** `CORS_ORIGIN=""` stops the service from starting, with:

```
[env] Invalid environment variables:
  - CORS_ORIGIN: CORS_ORIGIN must not be empty
```

An empty value is read as "this variable is switched off but still present", not as "not configured", so it is rejected rather than quietly treated as absent. If you are deploying somewhere that requires the key to exist, give it a real value rather than `""` — or set the other one and leave this absent entirely.

Each origin must be a **bare origin**: scheme, host and non-default port, with no path. `https://app.example.com` is right, `https://app.example.com/dashboard` is refused at boot. A trailing slash is tolerated but unnecessary. Getting this wrong is unusually costly, because a malformed value produces no CORS header at all: the backend boots, `/health` answers, the database connects, and every browser request is still refused with the evidence being a missing response header.

## 4. Deploy

1. In Railway: **New Project → Deploy from GitHub repo** (select the repo, branch `main`).
2. Railway detects `railway.toml`, builds with Nixpacks (`bun install --frozen-lockfile`),
   runs pre-deploy **`bun run dbi:migrate`** (Prisma 8 `prisma db migrate`) **before** routing traffic,
   then starts **`bun run start`**.
3. Add the environment variables (section 3) → **Deploy**.
4. Monitor: pre-deploy step output shows `db.migrate` result; healthcheck pings `/health`.

**Migration safety:** `prisma db migrate` applies *pending* migrations only and never resets
the database. If it fails, the deploy fails before traffic is routed — production stays on the
previous good deploy.

## 5. Seed (only if you ever use a fresh database)

Seeding is an explicit, idempotent command — never attached to `start`:

```powershell
bun run seed                    # default demo accounts
bun run seed pm@aurora.demo "ChangeThis#2026"   # optional custom PM + password
```

Re-running reports `skipped: n` and changes nothing.

## 6. Verification after deploy (from any machine)

Backend URL `https://<service>.up.railway.app`.

```powershell
# Public endpoints
curl https://<service>.up.railway.app/health          # 200 {"status":"ok",...}
curl https://<service>.up.railway.app/health/ready    # 200 {"database":"connected"}
curl -I https://<service>.up.railway.app/docs          # 200 HTML (Scalar)
curl https://<service>.up.railway.app/openapi.json     # 200; servers[0].url == API_BASE_URL
```

Then a business-logic smoke (demo accounts already seeded on the reused DB —
all password `DemoPass#2026`; see section 7):

- PM login `POST /auth/login` `pm@aurora.demo` / `DemoPass#2026` → 200 + JWT (header `x-auth-token` or body — use the one the API returns).
- Blocked-task flow (project `11111111-1111-4111-8111-111111111111`, task T3 is `blockedBy` T2):
  update event for blocked task → **409 BLOCKED_TASK_IN_PROGRESS**; update the blocking task first → retry succeeds.
- Client isolation: login `client@aurora.demo`, attempt to read/modify another project → 404/403.
- Optimistic lock: stale `version` on task update → **409 VERSION_CONFLICT**.
- Unauthenticated write → 401. Unknown route → 404.

## 7. Known limitations

- `STORAGE_PROVIDER=local`: attachment files live on Railway's ephemeral disk and are lost on
  redeploy (database rows remain). Keep `local` for the assessment; a persistent provider
  (S3/R2) is the upgrade path.
- Single replica; `numReplicas = 1` in `railway.toml`.
- Demo credentials (assessment): reset any of them with `bun run seed <email> <password>`.
  Seeded demo accounts (password `DemoPass#2026`): `pm@aurora.demo`, `uiux@aurora.demo`,
  `frontend@aurora.demo`, `backend@aurora.demo`, `client@aurora.demo`.

## 8. Redeploys

Push to `main` → Railway redeploys automatically (pre-deploy migration runs each time, no-ops when up to date).