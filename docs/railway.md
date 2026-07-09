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

## Backups

Phase 0 also requires an automated nightly off-platform `pg_dump` (see
CLAUDE.md locked decisions). That job is not part of this ticket; track it
with the Phase 0 checklist.
