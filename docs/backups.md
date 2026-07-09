# Postgres backups and restore

Nightly off-platform `pg_dump` of the primary Postgres, plus a documented
and once-verified restore procedure. This is a locked Phase 0 requirement
(see CLAUDE.md and ARCHITECTURE.md).

The backup entry point is `scripts/backup/pg-backup.sh`. It takes a
custom-format `pg_dump` of `DATABASE_URL`, verifies the archive with
`pg_restore --list`, optionally copies it to an off-platform rclone remote,
and prunes old local dumps.

## Environment variables

| Variable | Required | Default | Purpose |
| --- | --- | --- | --- |
| `DATABASE_URL` | yes | none | Postgres connection string to back up. |
| `BACKUP_DIR` | no | `./backups` | Local directory where dumps are written. |
| `BACKUP_RETENTION` | no | `14` | Number of local dumps to keep; older ones are pruned. |
| `BACKUP_PREFIX` | no | `ai-manager` | Dump filename prefix. |
| `BACKUP_RCLONE_REMOTE` | no | unset | rclone destination for the off-platform copy, e.g. `r2:sealevel-backups/pg`. |

Client tool versions: `pg_dump` and `pg_restore` must be at least the
server's major version (Postgres 16 server needs client tools 16+). A v14
client refuses to dump a v16 server.

## Off-platform target

The off-platform destination is deliberately not hardcoded. The script
uploads to whatever `BACKUP_RCLONE_REMOTE` points at, so the target is an
rclone remote configured on the machine or service that runs the backup.
Recommended: an S3-compatible object store outside Railway, such as
Cloudflare R2 or Backblaze B2, with a bucket lifecycle rule that expires
objects after 30 to 90 days. `BACKUP_RETENTION` governs local disk only;
remote retention belongs to the provider lifecycle rule so a compromised or
misconfigured runner cannot delete history.

When `BACKUP_RCLONE_REMOTE` is unset the dump stays in `BACKUP_DIR`. That is
the local dev mode and is how the script is verified without cloud
credentials. Production must set the remote so backups land off Railway.

## Running it locally

```bash
docker compose up -d postgres
DATABASE_URL=postgres://ai_manager:ai_manager@localhost:5432/ai_manager \
  BACKUP_DIR=./backups scripts/backup/pg-backup.sh
```

## Scheduling (nightly)

Two supported options. Option A is implemented now; option B becomes
available once the BullMQ worker (GH-3) is merged.

### Option A: Railway cron service (implemented path)

Railway supports cron schedules on a service. Create a small service in the
same Railway project whose only job is the backup:

1. New service from this repo, no long-running process.
2. Start command: `bash scripts/backup/pg-backup.sh`.
3. Cron schedule: `0 9 * * *` (09:00 UTC, roughly 1am Pacific).
4. Variables: `DATABASE_URL = ${{Postgres.DATABASE_URL}}` (reference, not a
   copied literal), `BACKUP_RCLONE_REMOTE`, and an `RCLONE_CONFIG_*` set of
   env vars for the remote credentials (rclone reads remotes from env, e.g.
   `RCLONE_CONFIG_R2_TYPE=s3`, `RCLONE_CONFIG_R2_PROVIDER=Cloudflare`,
   `RCLONE_CONFIG_R2_ACCESS_KEY_ID`, `RCLONE_CONFIG_R2_SECRET_ACCESS_KEY`,
   `RCLONE_CONFIG_R2_ENDPOINT`).
5. The service image must include `postgresql-client` (v16+) and `rclone`.

`BACKUP_DIR` can stay at its default inside the cron container; the local
copy is ephemeral scratch space and the rclone upload is the durable copy.

### Option B: BullMQ repeatable job (after GH-3)

Once the worker's queue infrastructure lands, register a repeatable job
(cron `0 9 * * *`) whose processor shells out to
`scripts/backup/pg-backup.sh` with the same env vars. This keeps scheduling
in one place with the other jobs. Not implemented in this ticket to avoid
coupling to the in-flight queue work.

## Restore procedure

Dumps are `pg_dump --format=custom` archives; restore with `pg_restore`.

1. Fetch the dump (from the rclone remote if restoring from off-platform):

   ```bash
   rclone copy "$BACKUP_RCLONE_REMOTE/ai-manager-<STAMP>.dump" .
   ```

2. Create a fresh target database (never restore over the live one unless
   you mean to):

   ```bash
   createdb -h <host> -U <user> <target_db>
   ```

3. Restore:

   ```bash
   pg_restore --no-owner --dbname=postgres://<user>:<pass>@<host>:<port>/<target_db> \
     ai-manager-<STAMP>.dump
   ```

4. Verify: row counts of key tables match expectations, and
   `SELECT * FROM schema_migrations;` matches the source database.

## Restore drill

Run this against the local docker-compose Postgres to prove the whole loop
(dump, restore into a second database, compare migrations). Repeat it after
any change to the backup script and at least once against the Railway
database once it exists.

```bash
DB=postgres://ai_manager:ai_manager@localhost:5432/ai_manager

# 1. Take a dump with the real script
DATABASE_URL=$DB BACKUP_DIR=./backups scripts/backup/pg-backup.sh

# 2. Restore into a second database
createdb -h localhost -U ai_manager ai_manager_restore_drill
pg_restore --no-owner \
  --dbname=postgres://ai_manager:ai_manager@localhost:5432/ai_manager_restore_drill \
  ./backups/ai-manager-<STAMP>.dump

# 3. Compare schema_migrations between source and restored copy
psql $DB -tAc 'SELECT name FROM schema_migrations ORDER BY name'
psql postgres://ai_manager:ai_manager@localhost:5432/ai_manager_restore_drill \
  -tAc 'SELECT name FROM schema_migrations ORDER BY name'
# The two lists must be identical.

# 4. Clean up
dropdb -h localhost -U ai_manager ai_manager_restore_drill
```

Note for macOS hosts with Postgres 14 client tools: run the drill inside the
compose container instead, which ships v16 tools:

```bash
docker compose cp scripts/backup/pg-backup.sh postgres:/tmp/pg-backup.sh
docker compose exec postgres env \
  DATABASE_URL=postgres://ai_manager:ai_manager@localhost:5432/ai_manager \
  BACKUP_DIR=/tmp/backups bash /tmp/pg-backup.sh
```

Then run the createdb / pg_restore / psql steps via `docker compose exec
postgres ...` the same way.
