#!/usr/bin/env bash
#
# /usr/local/bin/backup-retry.sh — finish the night's off-site backup whatever the
# network does. Shared by restic-push, rentbook-backup and guesthub.
#
#   backup-retry.sh run <job>        run <job> until it has succeeded today, for at most 4 h
#   backup-retry.sh failcheck <job>  ping healthchecks /fail ONCE if <job> has no success today
#
# run:
#   - holds /var/lock/<job>.lock (flock -n): a second run while one is active exits 0.
#   - exits 0 at once when /var/lib/backup-status/<job>.last-success already holds today.
#   - before EVERY attempt checks the uplink (curl to B2, 10 s). No answer = the backup
#     is not started; wait for the next round.
#   - back-off between rounds: 1, 2, 5, 10, 15 min, then every 15 min; gives up (exit 1)
#     when the next wait would pass 4 h from the start.
#   - an attempt counts as a success only when the command exits 0 AND the job's VERIFY
#     command (snapshot / object of today exists) exits 0. Then, immediately: today's date
#     is written to <job>.last-success and the healthchecks success ping is sent.
#   - no healthchecks /fail is ever sent from here per attempt (see failcheck).
#
# failcheck (called by backup-catchup.sh at 12:00): no success today -> one /fail ping,
# remembered in <job>.fail-pinged so later runs of the same day stay quiet.
#
# Jobs: /etc/backup-retry/jobs.d/<job>.conf, sourced as root, NO secrets in it:
#   CMD          shell snippet that runs the backup           (required)
#   VERIFY       shell snippet, exit 0 = today's copy is in B2 (optional)
#   ENV_FILE     KEY=value file loaded for CMD/VERIFY/pings    (optional, never sourced as shell)
#   HC_URL_VAR   name of the variable holding the healthchecks URL (optional)
#
# "Today" is the host's date (UTC), the same clock as the timers and the dump file names.
# Secrets and URLs are never printed.
#
# BACKUP_RETRY_* variables below exist so the logic can be tested without waiting hours.
set -uo pipefail

JOBS_DIR="${BACKUP_RETRY_JOBS_DIR:-/etc/backup-retry/jobs.d}"
STATUS_DIR="${BACKUP_RETRY_STATUS_DIR:-/var/lib/backup-status}"
LOCK_DIR="${BACKUP_RETRY_LOCK_DIR:-/var/lock}"
NET_URL="${BACKUP_RETRY_NET_URL:-https://api.backblazeb2.com}"
MAX_SECONDS="${BACKUP_RETRY_MAX_SECONDS:-14400}"
read -r -a BACKOFF <<<"${BACKUP_RETRY_BACKOFF:-60 120 300 600 900}"

MODE="${1:-}"
JOB="${2:-}"

log() { printf '%s [backup-retry:%s] %s\n' "$(date '+%F %T')" "${JOB:-?}" "$*"; }
die() { log "ERROR: $*" >&2; exit 2; }

today() { date +%F; }

success_today() {
  [[ "$(cat "$STATUS_DIR/$JOB.last-success" 2>/dev/null)" == "$(today)" ]]
}

# atomic: a reader never sees a half-written date
write_status() {
  local tmp
  tmp="$(mktemp "$STATUS_DIR/.tmp.XXXXXX")" || return 1
  printf '%s\n' "$2" >"$tmp" && chmod 644 "$tmp" && mv -f "$tmp" "$STATUS_DIR/$1"
}

# KEY=value lines only; the file is parsed, never executed. A variable already set by
# the environment (systemd EnvironmentFile) wins.
load_env_file() {
  local f="$1" line k v
  [[ -r "$f" ]] || { log "ENV_FILE $f is not readable — relying on the inherited environment"; return 0; }
  while IFS= read -r line || [[ -n "$line" ]]; do
    [[ "$line" =~ ^[[:space:]]*(export[[:space:]]+)?([A-Za-z_][A-Za-z0-9_]*)=(.*)$ ]] || continue
    k="${BASH_REMATCH[2]}"
    v="${BASH_REMATCH[3]}"
    if [[ "$v" =~ ^\"(.*)\"$ || "$v" =~ ^\'(.*)\'$ ]]; then v="${BASH_REMATCH[1]}"; fi
    [[ -v "$k" ]] || export "$k=$v"
  done <"$f"
}

load_job() {
  [[ "$JOB" =~ ^[A-Za-z0-9._-]+$ ]] || die "bad job name '${JOB}'"
  local conf="$JOBS_DIR/$JOB.conf"
  [[ -r "$conf" ]] || die "no job definition $conf"
  CMD=''; VERIFY=''; ENV_FILE=''; HC_URL_VAR=''
  # shellcheck disable=SC1090
  . "$conf"
  [[ -n "$CMD" ]] || die "$conf defines no CMD"
  [[ -d "$STATUS_DIR" && -w "$STATUS_DIR" ]] || die "status dir $STATUS_DIR is missing or not writable for $(id -un)"
  [[ -z "$ENV_FILE" ]] || load_env_file "$ENV_FILE"
}

net_ok() { curl -sS -m 10 -o /dev/null "$NET_URL" 2>/dev/null; }

# $1 = "" (success) or "/fail". Never prints the URL.
hc_ping() {
  local var="${HC_URL_VAR:-}" url
  if [[ -z "$var" ]]; then log "healthchecks: none configured for this job — no ping${1:-}"; return 0; fi
  url="${!var:-}"
  if [[ -z "$url" ]]; then log "healthchecks: \$${var} is empty — no ping${1:-}"; return 0; fi
  if curl -fsS -m 10 --retry 3 -o /dev/null "${url}${1:-}" 2>/dev/null; then
    log "healthchecks: ping${1:-} sent"
  else
    log "healthchecks: ping${1:-} FAILED (non-fatal)"
    return 1
  fi
}

# fd 9 is the lock: the job must not inherit it, or a leftover child would pin the lock
run_snippet() { bash -c "$1" "backup-job:$JOB" 9>&-; }

cmd_run() {
  load_job
  exec 9>"$LOCK_DIR/$JOB.lock" || die "cannot open $LOCK_DIR/$JOB.lock"
  if ! flock -n 9; then log "another run holds $LOCK_DIR/$JOB.lock — nothing to do"; exit 0; fi
  if success_today; then log "already succeeded today ($(today)) — nothing to do"; exit 0; fi

  export BACKUP_RETRY_WRAPPED=1
  local start now elapsed attempt=0 idx=0 delay rc
  start="$(date +%s)"
  log "start — window ${MAX_SECONDS}s, back-off ${BACKOFF[*]}s then every ${BACKOFF[-1]}s"

  while :; do
    attempt=$((attempt + 1))
    if net_ok; then
      log "attempt ${attempt}: uplink ok — running the backup"
      run_snippet "$CMD"; rc=$?
      if (( rc == 0 )); then
        if [[ -z "${VERIFY:-}" ]]; then
          rc=0
        else
          log "attempt ${attempt}: backup exited 0 — verifying today's copy"
          run_snippet "$VERIFY"; rc=$?
          (( rc == 0 )) || log "attempt ${attempt}: VERIFICATION FAILED (rc=${rc}) — not counted as a success"
        fi
        if (( rc == 0 )); then
          write_status "$JOB.last-success" "$(today)" || die "cannot write $STATUS_DIR/$JOB.last-success"
          log "SUCCESS on attempt ${attempt} — recorded $(today)"
          hc_ping "" || true
          exit 0
        fi
      else
        log "attempt ${attempt}: backup FAILED (rc=${rc})"
      fi
    else
      log "attempt ${attempt}: no uplink (${NET_URL} unreachable) — backup not started"
    fi

    delay="${BACKOFF[idx]:-${BACKOFF[-1]}}"
    (( idx < ${#BACKOFF[@]} )) && idx=$((idx + 1))
    now="$(date +%s)"; elapsed=$((now - start))
    if (( elapsed + delay > MAX_SECONDS )); then
      log "giving up after ${elapsed}s, ${attempt} attempt(s), no success — the catch-up timer will start a new window"
      exit 1
    fi
    log "next attempt in ${delay}s"
    sleep "$delay"
  done
}

cmd_failcheck() {
  load_job
  if success_today; then log "succeeded today — no fail ping"; exit 0; fi
  if [[ "$(cat "$STATUS_DIR/$JOB.fail-pinged" 2>/dev/null)" == "$(today)" ]]; then
    log "no success today, /fail already pinged today"; exit 0
  fi
  log "NO SUCCESS TODAY ($(today)) at the cut-off"
  if hc_ping "/fail"; then write_status "$JOB.fail-pinged" "$(today)" || true; fi
}

case "$MODE" in
  run)       cmd_run ;;
  failcheck) cmd_failcheck ;;
  *)         echo "usage: $0 run|failcheck <job>" >&2; exit 2 ;;
esac
