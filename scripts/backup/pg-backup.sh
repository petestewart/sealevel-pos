#!/usr/bin/env bash
#
# Nightly Postgres backup: pg_dump custom-format archive with retention
# pruning and an optional off-platform upload step.
#
# Required env:
#   DATABASE_URL            Postgres connection string to back up.
#
# Optional env:
#   BACKUP_DIR              Local directory for dump files (default: ./backups).
#   BACKUP_RETENTION        Number of local dumps to keep (default: 14).
#   BACKUP_PREFIX           Dump filename prefix (default: ai-manager).
#   BACKUP_RCLONE_REMOTE    rclone destination, e.g. "r2:sealevel-backups/pg".
#                           When set, each dump is copied there after it is
#                           written. When unset, dumps stay in BACKUP_DIR only
#                           (fine for local dev; production must set this so
#                           backups land off-platform). Remote retention is
#                           handled by the storage provider's lifecycle rules,
#                           see docs/backups.md.
#
# Requires: pg_dump and pg_restore whose major version is >= the server's
# (e.g. Postgres 16 server needs client tools 16+). rclone is only required
# when BACKUP_RCLONE_REMOTE is set.
#
# Usage: DATABASE_URL=postgres://... scripts/backup/pg-backup.sh

set -euo pipefail

log() { printf '%s %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*"; }
fail() { log "ERROR: $*" >&2; exit 1; }

[ -n "${DATABASE_URL:-}" ] || fail "DATABASE_URL is required"
command -v pg_dump >/dev/null 2>&1 || fail "pg_dump not found on PATH"
command -v pg_restore >/dev/null 2>&1 || fail "pg_restore not found on PATH"

BACKUP_DIR="${BACKUP_DIR:-./backups}"
BACKUP_RETENTION="${BACKUP_RETENTION:-14}"
BACKUP_PREFIX="${BACKUP_PREFIX:-ai-manager}"
BACKUP_RCLONE_REMOTE="${BACKUP_RCLONE_REMOTE:-}"

case "$BACKUP_RETENTION" in
  ''|*[!0-9]*) fail "BACKUP_RETENTION must be a positive integer, got: $BACKUP_RETENTION" ;;
esac
[ "$BACKUP_RETENTION" -ge 1 ] || fail "BACKUP_RETENTION must be >= 1"

mkdir -p "$BACKUP_DIR"

STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
DUMP_FILE="$BACKUP_DIR/$BACKUP_PREFIX-$STAMP.dump"
TMP_FILE="$DUMP_FILE.partial"
# Never leave a partial archive behind, whatever fails below. After the
# successful mv the temp file no longer exists and this is a no-op.
trap 'rm -f "$TMP_FILE"' EXIT

# 1. Dump (custom format, compressed, restorable with pg_restore).
log "Dumping to $DUMP_FILE"
pg_dump --format=custom --no-password --file="$TMP_FILE" "$DATABASE_URL"

# 2. Verify the archive is readable before promoting it.
pg_restore --list "$TMP_FILE" >/dev/null || { rm -f "$TMP_FILE"; fail "dump archive failed verification"; }
mv "$TMP_FILE" "$DUMP_FILE"
log "Dump complete: $(du -h "$DUMP_FILE" | cut -f1 | tr -d ' ') $DUMP_FILE"

# 3. Off-platform upload (optional, env-driven).
if [ -n "$BACKUP_RCLONE_REMOTE" ]; then
  command -v rclone >/dev/null 2>&1 || fail "BACKUP_RCLONE_REMOTE is set but rclone is not installed"
  log "Uploading to $BACKUP_RCLONE_REMOTE"
  rclone copy "$DUMP_FILE" "$BACKUP_RCLONE_REMOTE"
  log "Upload complete"
else
  log "BACKUP_RCLONE_REMOTE not set; dump kept locally only"
fi

# 4. Local retention: keep the newest BACKUP_RETENTION dumps.
PRUNED=0
while IFS= read -r old; do
  rm -f -- "$old"
  PRUNED=$((PRUNED + 1))
  log "Pruned $old"
done < <(ls -1t "$BACKUP_DIR"/"$BACKUP_PREFIX"-*.dump 2>/dev/null | tail -n +"$((BACKUP_RETENTION + 1))")

log "Done: kept newest $BACKUP_RETENTION local dump(s), pruned $PRUNED"
