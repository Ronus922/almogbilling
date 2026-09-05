#!/usr/bin/env bash
#
# scripts/backup/pg-backup.sh — nightly Postgres backup of the SHARED Supabase
# cluster on this server (container `supabase-db`), run through `docker exec`.
#
# Writes two gzipped dumps into $BACKUP_DIR (default /var/backups/supabase/daily):
#   (a) cluster-<stamp>.sql.gz        pg_dumpall of the whole cluster — every
#                                     project database on the server (billing,
#                                     guesthub, invoiceflow, …) plus roles.
#   (b) <db>-<stamp>.sql.gz           pg_dump of the billing database alone
#                                     (default proj_billing) for a fast restore.
#
# Then prunes local files older than $RETENTION_DAYS (default 7) and, if
# $HEALTHCHECK_BACKUP_URL is set, pings it (…/fail on any error).
#
# Runs as root on the server via billing-backup.timer (03:00). Read-only against
# the database: the only writes are files under $BACKUP_DIR.
#
# Env (all optional):
#   PG_CONTAINER   docker container that runs postgres    (supabase-db)
#   PG_USER        role used for the dumps                (postgres)
#   BILLING_DB     database name for dump (b)             (proj_billing)
#   BACKUP_DIR     target directory                       (/var/backups/supabase/daily)
#   RETENTION_DAYS local retention                        (7)
#   MIN_BYTES      sanity floor for a dump file           (10240)
#   HEALTHCHECK_BACKUP_URL   healthchecks.io ping URL     (unset = no ping)
#
set -Eeuo pipefail

PG_CONTAINER="${PG_CONTAINER:-supabase-db}"
PG_USER="${PG_USER:-postgres}"
BILLING_DB="${BILLING_DB:-proj_billing}"
BACKUP_DIR="${BACKUP_DIR:-/var/backups/supabase/daily}"
RETENTION_DAYS="${RETENTION_DAYS:-7}"
MIN_BYTES="${MIN_BYTES:-10240}"
STAMP="$(date +%Y%m%d-%H%M%S)"

log()  { printf '%s [pg-backup] %s\n' "$(date '+%F %T')" "$*"; }
fail() { printf '%s [pg-backup] ERROR: %s\n' "$(date '+%F %T')" "$*" >&2; }

ping_hc() {
  # $1 = "" (success) or "/fail"
  [[ -n "${HEALTHCHECK_BACKUP_URL:-}" ]] || return 0
  curl -fsS -m 10 --retry 3 -o /dev/null "${HEALTHCHECK_BACKUP_URL}$1" \
    || log "healthcheck ping${1} failed (non-fatal)"
}

on_error() {
  fail "aborted at line $1"
  rm -f "$BACKUP_DIR"/*.part 2>/dev/null || true
  ping_hc /fail
  exit 1
}
trap 'on_error $LINENO' ERR

# One dump = one function: docker exec → gzip → .part → sanity → atomic rename.
dump() {
  local label="$1" target="$2"; shift 2
  local part="${target}.part"
  log "dumping ${label} → $(basename "$target")"
  docker exec "$PG_CONTAINER" "$@" | gzip -9 > "$part"
  gzip -t "$part"
  local size; size="$(stat -c %s "$part")"
  if (( size < MIN_BYTES )); then
    fail "${label}: dump is only ${size} bytes (< MIN_BYTES=${MIN_BYTES}) — refusing to keep it"
    rm -f "$part"
    return 1
  fi
  mv "$part" "$target"
  log "${label}: ok (${size} bytes gzipped)"
}

command -v docker >/dev/null || { fail "docker not found"; exit 1; }
docker inspect "$PG_CONTAINER" >/dev/null 2>&1 || { fail "container ${PG_CONTAINER} not found"; exit 1; }
mkdir -p "$BACKUP_DIR"
chmod 700 "$BACKUP_DIR"

# (a) whole cluster — roles + every database on the server.
dump "cluster" "$BACKUP_DIR/cluster-${STAMP}.sql.gz" \
  pg_dumpall -U "$PG_USER"

# (b) billing database alone — plain SQL, meant to be replayed into an EMPTY
#     database (pg-restore.sh creates one). No --clean: its DROP preamble only
#     produces noise on a fresh database and hides real errors.
dump "$BILLING_DB" "$BACKUP_DIR/${BILLING_DB}-${STAMP}.sql.gz" \
  pg_dump -U "$PG_USER" -d "$BILLING_DB"

# Local retention.
pruned="$(find "$BACKUP_DIR" -maxdepth 1 -type f -name '*.sql.gz' -mtime "+${RETENTION_DAYS}" -print -delete | wc -l)"
log "retention: removed ${pruned} file(s) older than ${RETENTION_DAYS} days"

log "done: $(ls -1 "$BACKUP_DIR"/*-"${STAMP}".sql.gz | xargs -n1 basename | tr '\n' ' ')"
ping_hc ""
