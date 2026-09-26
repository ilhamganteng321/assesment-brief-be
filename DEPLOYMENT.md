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
| `.env.example` | Documented env variables (safe to commit) |
| `migrations/app/` | 4 committed Prisma 8 migration packages |
| `prisma.config.ts` | Migration config; reads `DATABASE_URL` from env |

`/health`, `/health/live`, `/health/ready` are public; `/docs` and `/openapi.json`
are served in production.

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
| `FRONTEND_URL` / `CORS_ORIGIN` | At least one required in production. The future Next.js frontend origin, e.g. `https://<frontend-domain>`. Both are accepted; comma-separated for multiple |
| `API_BASE_URL` | The deployed backend URL, e.g. `https://<service>.up.railway.app` (drives OpenAPI `servers` + docs) |
| `JWT_EXPIRES_IN` | optional, default `1d` |
| `MAX_UPLOAD_SIZE_MB`, `STORAGE_PROVIDER`, `STORAGE_LOCAL_DIR` | optional, defaults apply |

Do **not** set: `DATABASE_URL` variants, migration flags, or anything secret in plaintext elsewhere.

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