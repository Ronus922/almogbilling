#!/usr/bin/env bash
#
# scripts/backup/restic-push.sh — push $BACKUP_DIR to an off-site restic repo
# (Backblaze B2 in production) and apply the retention policy:
#   keep-daily 7 · keep-weekly 4 · keep-monthly 6 · prune
#
# Runs right after pg-backup.sh inside billing-backup.service. All configuration
# is environment (EnvironmentFile=/etc/billing/backup.env):
#   RESTIC_REPOSITORY   e.g. b2:<bucket>:supabase        (REQUIRED — unset = skip)
#   RESTIC_PASSWORD     repo encryption password          (or RESTIC_PASSWORD_FILE)
#   B2_ACCOUNT_ID / B2_ACCOUNT_KEY                        (B2 backend credentials)
#   BACKUP_DIR          what to push                      (/var/backups/supabase/daily)
#
# Decision: an unset RESTIC_REPOSITORY is a SKIP (exit 0, loud message), not a
# failure — local dumps keep working before the off-site bucket exists, and the
# healthcheck for the local step already fired from pg-backup.sh.
#
set -Eeuo pipefail

BACKUP_DIR="${BACKUP_DIR:-/var/backups/supabase/daily}"

log()  { printf '%s [restic-push] %s\n' "$(date '+%F %T')" "$*"; }
fail() { printf '%s [restic-push] ERROR: %s\n' "$(date '+%F %T')" "$*" >&2; }

if [[ -z "${RESTIC_REPOSITORY:-}" ]]; then
  log "RESTIC_REPOSITORY not set — skipping off-site push (local dumps only)"
  exit 0
fi
command -v restic >/dev/null || { fail "restic not installed (apt install restic)"; exit 1; }
if [[ -z "${RESTIC_PASSWORD:-}" && -z "${RESTIC_PASSWORD_FILE:-}" ]]; then
  fail "RESTIC_PASSWORD or RESTIC_PASSWORD_FILE must be set"; exit 1
fi
[[ -d "$BACKUP_DIR" ]] || { fail "BACKUP_DIR ${BACKUP_DIR} does not exist"; exit 1; }

# First run: initialise the repository if it is not one yet.
if ! restic cat config >/dev/null 2>&1; then
  log "repository not initialised — running restic init"
  restic init
fi

log "backup ${BACKUP_DIR} → ${RESTIC_REPOSITORY}"
restic backup "$BACKUP_DIR" --tag supabase-daily --host "$(hostname -s)"

log "forget/prune (daily 7 · weekly 4 · monthly 6)"
restic forget --keep-daily 7 --keep-weekly 4 --keep-monthly 6 --prune

log "done — latest snapshots:"
restic snapshots --latest 3 --compact
