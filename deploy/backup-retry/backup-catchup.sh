#!/usr/bin/env bash
#
# /usr/local/bin/backup-catchup.sh — hourly 04:00–12:00 (host time, UTC): for every job in
# /etc/backup-retry/jobs.d, if <job>.last-success does not hold today's date, start
# backup-retry@<job>.service (which runs backup-retry.sh with its back-off and its lock).
# A job that already succeeded today is left alone. At 12:00 jobs still without a success
# also get their one healthchecks /fail ping (backup-retry.sh failcheck).
#
# Started by backup-catchup.timer. BACKUP_CATCHUP_* variables exist for testing.
set -uo pipefail

JOBS_DIR="${BACKUP_RETRY_JOBS_DIR:-/etc/backup-retry/jobs.d}"
STATUS_DIR="${BACKUP_RETRY_STATUS_DIR:-/var/lib/backup-status}"
RETRY_BIN="${BACKUP_CATCHUP_RETRY_BIN:-/usr/local/bin/backup-retry.sh}"
FIRST_HOUR=4
LAST_HOUR=12

log() { printf '%s [backup-catchup] %s\n' "$(date '+%F %T')" "$*"; }

hour=$((10#${BACKUP_CATCHUP_HOUR:-$(date +%H)}))
if (( hour < FIRST_HOUR || hour > LAST_HOUR )); then
  log "hour ${hour} is outside ${FIRST_HOUR}:00–${LAST_HOUR}:00 — nothing to do"
  exit 0
fi

start_job() {
  if [[ -n "${BACKUP_CATCHUP_START:-}" ]]; then
    $BACKUP_CATCHUP_START "$1"
  else
    systemctl start --no-block "backup-retry@$1.service"
  fi
}

today="$(date +%F)"
shopt -s nullglob
confs=("$JOBS_DIR"/*.conf)
(( ${#confs[@]} )) || { log "no jobs in $JOBS_DIR"; exit 0; }

for conf in "${confs[@]}"; do
  job="$(basename "$conf" .conf)"
  if [[ "$(cat "$STATUS_DIR/$job.last-success" 2>/dev/null)" == "$today" ]]; then
    log "${job}: succeeded today (${today}) — nothing to do"
    continue
  fi
  log "${job}: NO success recorded for ${today} (last-success: $(cat "$STATUS_DIR/$job.last-success" 2>/dev/null || echo never)) — starting backup-retry"
  start_job "$job" || log "${job}: could not start backup-retry (rc=$?)"
  if (( hour >= LAST_HOUR )); then
    "$RETRY_BIN" failcheck "$job" || true
  fi
done
