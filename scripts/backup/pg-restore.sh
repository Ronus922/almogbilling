#!/usr/bin/env bash
#
# scripts/backup/pg-restore.sh <dump.sql.gz> — prove a dump is restorable.
#
# Starts a THROWAWAY Postgres container (same image as production), replays the
# dump into it and prints `select count(*)` from the verification tables. The
# container is removed on exit unless --keep is given (then connect on
# $RESTORE_PORT to inspect it).
#
#   scripts/backup/pg-restore.sh /var/backups/supabase/daily/proj_billing-20260905-030000.sql.gz
#   scripts/backup/pg-restore.sh --keep /var/backups/supabase/daily/cluster-20260905-030000.sql.gz
#
# Accepts both dump kinds pg-backup.sh writes:
#   cluster-*.sql.gz   pg_dumpall → replayed against the `postgres` database
#                      (it contains CREATE DATABASE + \connect lines itself).
#                      Roles/extensions the image already ships produce
#                      expected, non-fatal errors ("already exists", "reserved role").
#   <db>-*.sql.gz      pg_dump    → replayed into a freshly created <db>.
#
# Env (all optional):
#   PG_IMAGE          supabase/postgres:15.8.1.085   (match production)
#   RESTORE_CONTAINER billing-restore-<pid>
#   RESTORE_PORT      55440                          (5432-5434/55432 are taken on this host)
#   RESTORE_DB        database name inside the dump  (derived from filename)
#   VERIFY_TABLES     "public.debtors public.users public.app_settings"
#
set -Eeuo pipefail

KEEP=0
if [[ "${1:-}" == "--keep" ]]; then KEEP=1; shift; fi
FILE="${1:-}"
[[ -n "$FILE" && -f "$FILE" ]] || { echo "usage: $0 [--keep] <dump.sql.gz>" >&2; exit 2; }

PG_IMAGE="${PG_IMAGE:-supabase/postgres:15.8.1.085}"
RESTORE_CONTAINER="${RESTORE_CONTAINER:-billing-restore-$$}"
RESTORE_PORT="${RESTORE_PORT:-55440}"
VERIFY_TABLES="${VERIFY_TABLES:-public.debtors public.users public.app_settings}"
PGPASS="restore-only-$$"
BASE="$(basename "$FILE" .sql.gz)"

log()  { printf '%s [pg-restore] %s\n' "$(date '+%F %T')" "$*"; }
fail() { printf '%s [pg-restore] ERROR: %s\n' "$(date '+%F %T')" "$*" >&2; }

cleanup() {
  if (( KEEP )); then
    log "container ${RESTORE_CONTAINER} kept — psql postgresql://postgres:${PGPASS}@127.0.0.1:${RESTORE_PORT}/${RESTORE_DB:-postgres}"
  else
    docker rm -f "$RESTORE_CONTAINER" >/dev/null 2>&1 || true
  fi
}
trap cleanup EXIT

# Which kind of dump, and which database to verify in.
if [[ "$BASE" == cluster-* ]]; then
  KIND=cluster
  RESTORE_DB="${RESTORE_DB:-proj_billing}"
else
  KIND=single
  RESTORE_DB="${RESTORE_DB:-${BASE%-*-*}}"   # strip -YYYYMMDD-HHMMSS
fi

gzip -t "$FILE"
log "starting ${PG_IMAGE} as ${RESTORE_CONTAINER} on 127.0.0.1:${RESTORE_PORT}"
docker run -d --name "$RESTORE_CONTAINER" -p "127.0.0.1:${RESTORE_PORT}:5432" \
  -e POSTGRES_PASSWORD="$PGPASS" -e POSTGRES_HOST=/var/run/postgresql \
  -e POSTGRES_USER=supabase_admin -e POSTGRES_DB=postgres \
  "$PG_IMAGE" postgres -D /etc/postgresql >/dev/null

# The image's entrypoint runs its init scripts against a TEMPORARY server, stops
# it, then starts the real one — a bare `select 1` can succeed on the temporary
# instance and the restore would then be cut off by the restart. Wait for the
# entrypoint's own marker first, then for the final server to answer.
for _ in $(seq 1 120); do
  docker logs "$RESTORE_CONTAINER" 2>&1 | grep -q 'PostgreSQL init process complete; ready for start up.' && break
  sleep 1
done
docker logs "$RESTORE_CONTAINER" 2>&1 | grep -q 'PostgreSQL init process complete; ready for start up.' \
  || { fail "temporary postgres never finished its init"; exit 1; }
for _ in $(seq 1 60); do
  docker exec "$RESTORE_CONTAINER" psql -U postgres -d postgres -tAc 'select 1' >/dev/null 2>&1 && break
  sleep 1
done
docker exec "$RESTORE_CONTAINER" psql -U postgres -d postgres -tAc 'select 1' >/dev/null 2>&1 \
  || { fail "temporary postgres did not come up"; exit 1; }

if [[ "$KIND" == single ]]; then
  docker exec "$RESTORE_CONTAINER" psql -U postgres -d postgres -qc "create database \"${RESTORE_DB}\"" >/dev/null
  TARGET_DB="$RESTORE_DB"
else
  TARGET_DB=postgres
fi

log "replaying $(basename "$FILE") (${KIND}) into ${TARGET_DB}"
# ON_ERROR_STOP=0: a cluster dump re-creates roles/extensions the image already
# has; those errors are expected. We count them and show the unexpected ones.
ERRLOG="$(mktemp)"
gunzip -c "$FILE" | docker exec -i "$RESTORE_CONTAINER" psql -U postgres -d "$TARGET_DB" -q -v ON_ERROR_STOP=0 >/dev/null 2>"$ERRLOG" || true
errors="$(grep -c '^ERROR' "$ERRLOG" || true)"
unexpected="$(grep '^ERROR' "$ERRLOG" | grep -vE 'already exists|is a reserved role|role memberships are reserved|must be superuser|must be owner|permission denied|cannot drop|grant options cannot be granted back|must be member of role|owned event trigger|does not exist, skipping' || true)"
log "replay finished — ${errors} error line(s) ($(printf '%s' "$unexpected" | grep -c . || true) unexpected)"
if [[ -n "$unexpected" ]]; then printf "%s\n" "$unexpected" | sort | uniq -c | sort -rn | head -20 >&2; fi
rm -f "$ERRLOG"

log "verification counts in ${RESTORE_DB}:"
status=0
for t in $VERIFY_TABLES; do
  if n="$(docker exec "$RESTORE_CONTAINER" psql -U postgres -d "$RESTORE_DB" -tAc "select count(*) from ${t}" 2>/dev/null)"; then
    printf '  %-28s %s\n' "$t" "$n"
  else
    printf '  %-28s %s\n' "$t" "MISSING"; status=1
  fi
done
tables="$(docker exec "$RESTORE_CONTAINER" psql -U postgres -d "$RESTORE_DB" -tAc "select count(*) from information_schema.tables where table_schema='public'" 2>/dev/null || echo 0)"
log "public tables in ${RESTORE_DB}: ${tables}"
(( status == 0 )) && log "RESTORE OK" || { fail "a verification table is missing — restore incomplete"; exit 1; }
