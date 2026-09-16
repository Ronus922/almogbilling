#!/usr/bin/env bash
#
# scripts/backup/assert-storage-snapshot.sh — refuse to run the Storage garbage
# collector unless a FRESH off-site snapshot of the Storage bytes exists.
#
# Wired as `ExecStartPre=+` on billing-storage-cleanup.service. Exit 1 here and
# the unit never starts: not one object is listed, let alone deleted, and the
# OnFailure= alert fires.
#
# WHY NOT After= / Requires= ON billing-backup.service:
#   Both are timer-activated Type=oneshot units. Once billing-backup.service has
#   run it is `inactive (dead)` again, so `Requires=` would not observe "it
#   succeeded this morning" — it would START A SECOND BACKUP at cleanup time,
#   and `After=` only orders units inside one transaction, which two independent
#   timers never share. Worse, neither expresses the thing that actually matters:
#   systemd would be satisfied by a backup that ran, even one that failed to push
#   anything off-site. The snapshot itself is the only honest evidence, so this
#   asks the repository.
#
# Env (read from $BACKUP_ENV_FILE, default /etc/billing/backup.env — this script
# runs as root through ExecStartPre=+ so the 600 root:root file stays root-only
# and the B2 credentials never enter the GC process):
#   RESTIC_REPOSITORY / RESTIC_PASSWORD / B2_*      as in restic-push.sh
#   STORAGE_SNAPSHOT_MAX_AGE_HOURS  freshness bound (default 26 — the same
#                                   grace the billing-backup healthcheck uses,
#                                   i.e. one missed nightly run is a failure)
#
set -Eeuo pipefail

ENV_FILE="${BACKUP_ENV_FILE:-/etc/billing/backup.env}"
MAX_AGE_HOURS="${STORAGE_SNAPSHOT_MAX_AGE_HOURS:-26}"
TAG="storage"

log()  { printf '%s [assert-storage-snapshot] %s\n' "$(date '+%F %T')" "$*"; }
fail() { printf '%s [assert-storage-snapshot] REFUSING: %s\n' "$(date '+%F %T')" "$*" >&2; exit 1; }

if [[ -r "$ENV_FILE" ]]; then
  set -a; # shellcheck source=/dev/null
  . "$ENV_FILE"; set +a
fi

command -v restic >/dev/null || fail "restic is not installed — cannot prove a Storage backup exists"
[[ -n "${RESTIC_REPOSITORY:-}" ]] || fail "RESTIC_REPOSITORY is not set — nothing is pushed off-site, so nothing may be deleted"

snapshots_json="$(restic snapshots --tag "$TAG" --host "$(hostname -s)" --latest 1 --json 2>&1)" \
  || fail "restic snapshots failed: ${snapshots_json}"

status_line="$(
  MAX_AGE_HOURS="$MAX_AGE_HOURS" python3 - "$snapshots_json" <<'PY'
import json, os, re, sys
from datetime import datetime, timezone

def out(*parts):
    print("|".join(str(p) for p in parts))
    raise SystemExit(0)

try:
    snaps = json.loads(sys.argv[1]) or []
except json.JSONDecodeError:
    out("ERR", "could not parse the restic --json output")

if not snaps:
    out("ERR", "no snapshot tagged 'storage' exists in the repository")

snap = snaps[-1]
# restic stamps nanoseconds; datetime.fromisoformat takes at most microseconds.
raw = re.sub(r"\.\d+", "", snap["time"]).replace("Z", "+00:00")
when = datetime.fromisoformat(raw)
age_h = (datetime.now(timezone.utc) - when).total_seconds() / 3600.0
ok = age_h <= float(os.environ["MAX_AGE_HOURS"])
out("OK" if ok else "STALE", f"{age_h:.1f}", snap["short_id"], when.isoformat())
PY
)"

IFS="|" read -r status age short_id when <<<"$status_line"
case "$status" in
  OK)
    log "storage snapshot ${short_id} (${when}) is ${age}h old, limit ${MAX_AGE_HOURS}h — cleanup may run"
    ;;
  STALE)
    fail "the newest 'storage' snapshot (${short_id}, ${when}) is ${age}h old, limit ${MAX_AGE_HOURS}h — today's Storage bytes are not backed up; not touching anything"
    ;;
  *)
    fail "${age}"
    ;;
esac
