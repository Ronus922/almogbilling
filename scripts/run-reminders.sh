#!/usr/bin/env bash
#
# scripts/run-reminders.sh — triggers the reminders engine over localhost.
#
# Invoked by billing-reminders.timer (every 5 min). The cron secret is injected
# into the environment by systemd via EnvironmentFile=/etc/billing/billing.env
# (read by systemd as root, then exported into this process) — the same pattern
# billing.service uses. We never read the root-only file ourselves, and the
# secret is passed to curl via a stdin header so it never appears in `ps`.
#
set -Eeuo pipefail

URL="http://localhost:3003/api/cron/reminders"

if [[ -z "${BILLING_CRON_SECRET:-}" ]]; then
  echo "BILLING_CRON_SECRET not set in the environment" >&2
  exit 1
fi

# healthchecks.io dead-man switch (optional): HEALTHCHECK_REMINDERS_URL comes
# from the same EnvironmentFile. Success pings the URL, failure pings …/fail so
# the check turns red immediately instead of waiting out the grace period.
ping_hc() {
  [[ -n "${HEALTHCHECK_REMINDERS_URL:-}" ]] || return 0
  curl -fsS -m 10 --retry 3 -o /dev/null "${HEALTHCHECK_REMINDERS_URL}$1" || true
}

# --fail → non-zero exit on HTTP >= 400 so systemd records a failed run.
if printf 'x-cron-secret: %s' "$BILLING_CRON_SECRET" \
  | curl -fsS --max-time 110 -X POST -H @- "$URL"; then
  echo
  ping_hc ""
else
  rc=$?
  echo
  ping_hc /fail
  exit "$rc"
fi
