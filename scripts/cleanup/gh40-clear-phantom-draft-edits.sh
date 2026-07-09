#!/usr/bin/env bash
#
# One-off data repair for GH-40 / QA DEFECT-1.
#
# The "Edit then approve" DOM-reuse bug submitted Save edits on the first
# click, stamping payload.draft_edited=true and capturing
# payload.original_draft even though the operator never changed anything.
# The signature of a phantom edit is an original_draft whose subject and
# body match the current draft up to line endings (the browser submits
# textarea content with CRLF, so the phantom save also rewrote LF to
# CRLF). This script restores the draft fields from original_draft and
# removes original_draft and the draft_edited flag from exactly those
# rows (the app reads a missing draft_edited as false). Rows with a
# genuine edit are left untouched.
#
# Required env:
#   DATABASE_URL   Postgres connection string.
#
# Optional env:
#   DRY_RUN=1      Report the affected rows without updating.
#
# Usage: DATABASE_URL=postgres://... scripts/cleanup/gh40-clear-phantom-draft-edits.sh

set -euo pipefail

log() { printf '%s %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*"; }
fail() { log "ERROR: $*" >&2; exit 1; }

[ -n "${DATABASE_URL:-}" ] || fail "DATABASE_URL is required"
command -v psql >/dev/null 2>&1 || fail "psql not found on PATH"

PREDICATE="
  payload ? 'original_draft'
  AND replace(payload->'original_draft'->>'draft_subject', E'\r\n', E'\n')
      IS NOT DISTINCT FROM replace(payload->>'draft_subject', E'\r\n', E'\n')
  AND replace(payload->'original_draft'->>'draft_body', E'\r\n', E'\n')
      IS NOT DISTINCT FROM replace(payload->>'draft_body', E'\r\n', E'\n')
"

log "Rows matching the phantom-edit signature:"
psql "$DATABASE_URL" --no-psqlrc --set=ON_ERROR_STOP=1 -c \
  "SELECT id, status, payload->>'draft_edited' AS draft_edited FROM items WHERE $PREDICATE ORDER BY id;"

if [ "${DRY_RUN:-0}" = "1" ]; then
  log "DRY_RUN=1: no rows updated"
  exit 0
fi

log "Restoring drafts from original_draft and clearing draft_edited/original_draft on matching rows"
psql "$DATABASE_URL" --no-psqlrc --set=ON_ERROR_STOP=1 -c \
  "UPDATE items
   SET payload = (payload || jsonb_build_object(
         'draft_subject', payload->'original_draft'->'draft_subject',
         'draft_body', payload->'original_draft'->'draft_body'
       )) - 'original_draft' - 'draft_edited'
   WHERE $PREDICATE;"

log "Done"
