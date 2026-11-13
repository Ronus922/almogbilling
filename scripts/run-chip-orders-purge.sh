#!/usr/bin/env bash
#
# scripts/run-chip-orders-purge.sh — triggers the hourly purge of unpaid chip
# orders over localhost (13/11/2026). Mirrors run-archive-work-items.sh:
# invoked by billing-chip-orders-purge.timer, the cron secret is injected by
# systemd via EnvironmentFile (never read directly by this script) and sent to
# curl via stdin so it never appears in `ps`. The JSON answer (the run's
# counts) is echoed into the journal.
#
# Three tries 30s apart: a deploy restarts the app for ~90 seconds, and one
# hourly run landing in that window should not page anyone.
#
set -Eeuo pipefail

URL="http://localhost:3003/api/cron/chip-orders-purge"

if [[ -z "${BILLING_CRON_SECRET:-}" ]]; then
  echo "BILLING_CRON_SECRET not set in the environment" >&2
  exit 1
fi

rc=1
for attempt in 1 2 3; do
  if printf 'x-cron-secret: %s' "$BILLING_CRON_SECRET" \
    | curl -fsS --max-time 55 -X POST -H @- "$URL"; then
    echo
    exit 0
  else
    rc=$?
    echo
    echo "attempt $attempt failed (curl exit $rc)" >&2
    [[ $attempt -lt 3 ]] && sleep 30
  fi
done
exit "$rc"
