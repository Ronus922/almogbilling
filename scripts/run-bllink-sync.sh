#!/usr/bin/env bash
#
# scripts/run-bllink-sync.sh — daily Bllink sync over localhost.
#
# Invoked by billing-sync.timer (06:00 Asia/Jerusalem). Same pattern as
# run-reminders.sh: systemd injects /etc/billing/billing.env (read as root)
# into this process, the secret is handed to curl via a stdin header so it
# never appears in `ps`, and the route's JSON answer is printed so it lands in
# the journal. The route itself records every outcome in sync_runs and turns
# the dashboard banner red on failure — this script only has to run it.
#
set -Eeuo pipefail

PORT="${PORT:-3003}"
URL="http://127.0.0.1:${PORT}/api/sync/bllink"

if [[ -z "${CRM_CRON_SECRET:-}" ]]; then
  echo "CRM_CRON_SECRET not set in the environment" >&2
  exit 1
fi

echo "[billing-sync] POST ${URL} at $(date -u +%FT%TZ)"

# --fail-with-body → the JSON body is printed even on 409/502 and the exit code
# is non-zero, so `systemctl status billing-sync` shows a failed run with its
# stage + message.
if printf 'x-cron-secret: %s' "$CRM_CRON_SECRET" \
  | curl -sS --fail-with-body --max-time 300 -X POST -H @- -H 'content-type: application/json' -d '{}' "$URL"; then
  echo
  echo "[billing-sync] OK"
else
  rc=$?
  echo
  echo "[billing-sync] FAILED (curl exit ${rc})" >&2
  exit "$rc"
fi
