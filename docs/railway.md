# Railway provisioning: Postgres + Redis

Manual steps to provision the databases on the Railway Pro project and wire
env vars for the worker and console services. Verification of the deployed
services against these databases is tracked in GH-10.

## 1. Provision Postgres

1. Open the Railway project (Pro plan) in the dashboard.
2. Click "Create" (or "+ New") and choose "Database" then "Add PostgreSQL".
3. Railway creates a `Postgres` service with a `DATABASE_URL` variable of the
   form `postgresql://postgres:<password>@<host>:<port>/railway`.

## 2. Provision Redis

1. In the same project, click "Create", choose "Database", then "Add Redis".
2. Railway creates a `Redis` service with a `REDIS_URL` variable of the form
   `redis://default:<password>@<host>:<port>`.

## 3. Set env vars on worker and console

For each app service (`worker` and `console`):

1. Open the service, go to the "Variables" tab.
2. Add a variable reference (not a copied literal, so rotation propagates):
   - `DATABASE_URL` = `${{Postgres.DATABASE_URL}}`
   - `REDIS_URL` = `${{Redis.REDIS_URL}}`
3. Redeploy the service so the variables take effect.

Notes:
- Prefer the private-network URLs Railway exposes (e.g.
  `DATABASE_URL` over `DATABASE_PUBLIC_URL`) so app-to-database traffic stays
  inside the project network and avoids egress fees.
- Do not commit any of these values. Local dev uses `.env` (gitignored) with
  the docker-compose values from `.env.example`.

## 4. Run migrations against Railway

From a machine with the Railway `DATABASE_URL` exported (or via
`railway run` once the CLI is set up):

```bash
DATABASE_URL=<railway-postgres-url> npm run migrate -w @ai-manager/core
```

## 5. Verify

Connectivity smoke check (Postgres + Redis):

```bash
DATABASE_URL=<railway-postgres-url> REDIS_URL=<railway-redis-url> \
  npm run smoke -w @ai-manager/core
```

Full deployed verification (worker and console connecting on Railway) is
deferred to GH-10.

## 6. Deploy the worker service

Config-as-code lives in `apps/worker/railway.json` (build command, start
command, predeploy migrations, healthcheck, restart policy). The dashboard
steps below just point Railway at it.

1. In the Railway project: "Create" > "GitHub Repo" > `petestewart/ai-manager`.
   Name the service `worker`.
2. Service > Settings:
   - **Root directory**: leave at `/` (repo root). The npm workspaces
     install must run from the root so `@ai-manager/core` links.
   - **Config file path**: `apps/worker/railway.json`.
   - Branch: `main`.
3. Service > Variables (references, not literals, where available):

   | Variable | Value |
   | --- | --- |
   | `DATABASE_URL` | `${{Postgres.DATABASE_URL}}` |
   | `REDIS_URL` | `${{Redis.REDIS_URL}}` |
   | `ANTHROPIC_API_KEY` | from the Anthropic console |
   | `NOVU_SECRET_KEY` | from the Novu dashboard (unset = notifications no-op) |
   | `NOVU_SUBSCRIBER_PETE` | `pete` (must match the Novu subscriber id) |
   | `NOVU_SUBSCRIBER_ALISON` | `alison` |
   | `WORKER_CONCURRENCY` | optional, default 2 |
   | `NIXPACKS_NODE_VERSION` | `20` (pin the Node major; root engines only says `>=20`, so an unpinned rebuild could silently jump majors) |

   Do not set `PORT` or `BULL_BOARD_PORT`; Railway injects `PORT` and the
   worker listens on it (Bull Board and `/healthz` share that port).
4. Deploy. What the config does on each deploy:
   - build: `npm run build -w @ai-manager/core -w @ai-manager/worker`
   - predeploy: `node packages/core/dist/db/migrate.js` runs the
     already-built migration runner directly, so it does not depend on
     devDependencies (tsc) surviving into the deploy image. Migrations
     run before the new instance takes traffic; the runner is idempotent,
     so overlapping deploys are safe.
   - start: `npm run start -w @ai-manager/worker`
   - healthcheck: `GET /healthz` must return 200 within 120s.
5. Bull Board is served by the worker at `/admin/queues`. To reach it,
   either generate a Railway domain for the worker service (note: Bull
   Board has no auth of its own, so prefer the next option) or use
   `railway ssh`/private networking. Do not expose it publicly unauthed.

## 7. Deploy the console service

Config-as-code lives in `apps/console/railway.json`.

1. "Create" > "GitHub Repo" > same repo. Name the service `console`.
2. Service > Settings: root directory `/`, config file path
   `apps/console/railway.json`, branch `main`.
3. Service > Variables:

   | Variable | Value |
   | --- | --- |
   | `DATABASE_URL` | `${{Postgres.DATABASE_URL}}` |
   | `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY` | Clerk dashboard > API keys |
   | `CLERK_SECRET_KEY` | Clerk dashboard > API keys |

   Also set `NIXPACKS_NODE_VERSION` = `20` (same reason as the worker).
   `NEXT_PUBLIC_*` vars are inlined at build time; changing them requires a
   redeploy, not just a restart.
4. Settings > Networking: "Generate Domain" so operators can reach the
   console. Add that domain to the Clerk application's allowed origins.
5. Deploy. Build `npm run build -w @ai-manager/console`, start
   `npm run start -w @ai-manager/console` (`next start` binds Railway's
   `PORT`), healthcheck `GET /api/healthz` (public route, no Clerk session
   needed).

## 8. Backup cron service (nightly pg_dump)

Per docs/backups.md option A:

1. "Create" > "GitHub Repo" > same repo. Name the service `pg-backup`.
2. Settings: **Cron Schedule** `0 9 * * *` (09:00 UTC, ~1am Pacific).
   Start command: `bash scripts/backup/pg-backup.sh`.
3. Variables: `DATABASE_URL = ${{Postgres.DATABASE_URL}}`,
   `BACKUP_RCLONE_REMOTE` (e.g. `r2:sealevel-backups/pg`), and the
   `RCLONE_CONFIG_R2_*` credential set (see docs/backups.md).
4. The image must include `postgresql-client` 16+ and `rclone`. The stock
   Nixpacks node image does not ship either, so this service needs a
   nixpacks config or Dockerfile adding them (tracked with the Phase 0
   checklist).

## 9. Verify the deployed system (GH-10 acceptance)

Local restart-survival, queue-drain, and dead-letter evidence is captured
in the GH-10 PR. Repeat on Railway once the services are up:

1. Both services report healthy (green healthchecks) in the dashboard.
2. Open Bull Board (`/admin/queues` on the worker): the `test-heartbeat`
   schedule fires every minute and completes; the `test-fail-demo` job sits
   in the Failed set after 3 attempts (dead-letter visibility).
3. Restart-survival: note the queue counts in Bull Board, then "Restart"
   (or redeploy) the worker service mid-minute. After it comes back, no
   waiting/delayed jobs were lost and processing resumes. SIGTERM handling
   in `apps/worker/src/index.ts` closes the worker gracefully, so an
   in-flight job either completes or is retried by BullMQ, never dropped.
