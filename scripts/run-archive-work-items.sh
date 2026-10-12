#!/usr/bin/env bash
#
# scripts/run-archive-work-items.sh — triggers the unified תקלות/משימות
# archive sweep over localhost (11/10/2026). Mirrors run-reminders.sh exactly:
# invoked by billing-archive-work-items.timer (daily), the cron secret is
# injected by systemd via EnvironmentFile (never read directly by this
# script), and sent to curl via stdin so it never appears in `ps`.
#
set -Eeuo pipefail

URL="http://localhost:3003/api/cron/archive-work-items"

if [[ -z "${BILLING_CRON_SECRET:-}" ]]; then
  echo "BILLING_CRON_SECRET not set in the environment" >&2
  exit 1
fi

if printf 'x-cron-secret: %s' "$BILLING_CRON_SECRET" \
  | curl -fsS --max-time 50 -X POST -H @- "$URL"; then
  echo
else
  rc=$?
  echo
  exit "$rc"
fi
