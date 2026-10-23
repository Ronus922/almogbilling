#!/usr/bin/env bash
#
# /usr/local/bin/backup-verify-restic.sh <tag>... — exit 0 only if, for EVERY tag, the
# newest snapshot in $RESTIC_REPOSITORY was taken today (host date). Read-only; used as
# the VERIFY step of backup-retry.sh jobs. Needs RESTIC_REPOSITORY/credentials in the
# environment (backup-retry.sh loads them from the job's ENV_FILE).
set -uo pipefail

(( $# )) || { echo "usage: $0 <tag>..." >&2; exit 2; }
today="$(date +%F)"

for tag in "$@"; do
  json="$(restic snapshots --tag "$tag" --json 2>/dev/null)" \
    || { echo "verify: cannot list snapshots tagged '${tag}'" >&2; exit 1; }
  latest="$(jq -r '[.[].time] | max // empty' <<<"$json" 2>/dev/null)"
  [[ -n "$latest" ]] || { echo "verify: no snapshot tagged '${tag}'" >&2; exit 1; }
  day="$(date -d "$latest" +%F 2>/dev/null)" \
    || { echo "verify: unparsable snapshot time for '${tag}'" >&2; exit 1; }
  [[ "$day" == "$today" ]] \
    || { echo "verify: newest '${tag}' snapshot is from ${day}, not ${today}" >&2; exit 1; }
  echo "verify: '${tag}' snapshot from ${latest} — ok"
done
