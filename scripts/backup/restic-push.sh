#!/usr/bin/env bash
#
# scripts/backup/restic-push.sh — push the nightly backup to an off-site restic
# repo (Backblaze B2 in production) and apply the retention policy:
#   keep-daily 7 · keep-weekly 4 · keep-monthly 6 · prune
#
# TWO snapshots go into the SAME repository, in this order:
#   1. $BACKUP_DIR   — the Postgres dumps pg-backup.sh just wrote   --tag supabase-daily
#   2. $STORAGE_DIR  — the Supabase Storage object bytes             --tag storage
#
# WHY (2) EXISTS: pg_dumpall captures `storage.objects` — the METADATA — but the
# object BYTES live on local disk (the storage-api container runs with
# STORAGE_BACKEND=file and FILE_STORAGE_BACKEND_PATH=/var/lib/storage, bind-mounted
# from $STORAGE_DIR). Without this snapshot a restore comes back looking healthy,
# with every attachment, invoice and document a broken link. Added 16/09/2026 as
# prerequisite #1 of arming the Storage garbage collector with --apply.
#
# The dumps go FIRST so a Storage push that fails cannot cost us the database
# backup. Both are in the same repo (dedup across both, one credential, one
# prune), told apart by their tag and by their path.
#
# RETENTION IS UNCHANGED for the dumps: `restic forget` groups by host+paths, so
# the two path sets are two independent groups and each keeps 7/4/6 of its own.
# --group-by is now passed explicitly rather than left to restic's default, so a
# future default change cannot silently merge the groups.
#
# All configuration is environment (EnvironmentFile=/etc/billing/backup.env):
#   RESTIC_REPOSITORY   e.g. b2:<bucket>:supabase        (REQUIRED — unset = skip)
#   RESTIC_PASSWORD     repo encryption password          (or RESTIC_PASSWORD_FILE)
#   B2_ACCOUNT_ID / B2_ACCOUNT_KEY                        (B2 backend credentials)
#   BACKUP_DIR          the dumps to push                 (/var/backups/supabase/daily)
#   STORAGE_DIR         Storage object bytes              (/opt/supabase/docker/volumes/storage)
#                       set to the empty string to skip the Storage snapshot
#
# Decision: an unset RESTIC_REPOSITORY is a SKIP (exit 0, loud message), not a
# failure — local dumps keep working before the off-site bucket exists, and the
# healthcheck for the local step already fired from pg-backup.sh.
#
set -Eeuo pipefail

BACKUP_DIR="${BACKUP_DIR:-/var/backups/supabase/daily}"
STORAGE_DIR="${STORAGE_DIR-/opt/supabase/docker/volumes/storage}"

log()  { printf '%s [restic-push] %s\n' "$(date '+%F %T')" "$*"; }
fail() { printf '%s [restic-push] ERROR: %s\n' "$(date '+%F %T')" "$*" >&2; }

# pg-backup.sh already pinged the healthcheck GREEN for the local dumps by the
# time this script runs, so a failure here would otherwise leave the check
# happily green with nothing off-site. Turn it red.
on_error() {
  fail "aborted at line $1"
  if [[ -n "${HEALTHCHECK_BACKUP_URL:-}" ]]; then
    curl -fsS -m 10 --retry 3 -o /dev/null "${HEALTHCHECK_BACKUP_URL}/fail" \
      || log "healthcheck ping/fail failed (non-fatal)"
  fi
  exit 1
}
trap 'on_error $LINENO' ERR

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

HOST="$(hostname -s)"

# (1) The Postgres dumps — first, so a Storage failure never costs us these.
log "backup ${BACKUP_DIR} → ${RESTIC_REPOSITORY}  [tag supabase-daily]"
restic backup "$BACKUP_DIR" --tag supabase-daily --host "$HOST"

# (2) Supabase Storage object bytes. Same repo, own tag, own path — and so its
#     own retention group. An empty STORAGE_DIR is an explicit opt-out; a path
#     that is set but missing is an error, because silently skipping it is what
#     the whole snapshot exists to prevent.
if [[ -z "$STORAGE_DIR" ]]; then
  log "STORAGE_DIR empty — Storage object bytes NOT backed up (explicit opt-out)"
else
  [[ -d "$STORAGE_DIR" ]] || { fail "STORAGE_DIR ${STORAGE_DIR} does not exist"; exit 1; }
  log "backup ${STORAGE_DIR} → ${RESTIC_REPOSITORY}  [tag storage]"
  restic backup "$STORAGE_DIR" --tag storage --host "$HOST"
fi

# Grouped by host+paths (restic's own default, pinned here): the dumps and the
# Storage bytes are separate groups, so this is the SAME 7/4/6 the dumps have
# always had, now also applied to Storage. Never filtered by --tag: a forget
# that only saw one group would expire the other one's snapshots wholesale.
log "forget/prune (daily 7 · weekly 4 · monthly 6, per host+paths group)"
restic forget --group-by host,paths --keep-daily 7 --keep-weekly 4 --keep-monthly 6 --prune

log "done — latest snapshots:"
restic snapshots --latest 3 --compact
