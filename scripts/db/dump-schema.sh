#!/usr/bin/env bash
#
# scripts/db/dump-schema.sh [out-file] — deterministic schema-only dump of the
# billing database, in dbmate's layout (schema + schema_migrations rows), so two
# dumps can be diffed. Default output: db/schema.sql.
#
# Connection: DATABASE_URL (env, else .env.local). Two ways to run pg_dump:
#   PG_CONTAINER=<docker container>   → docker exec <container> pg_dump -U $PG_USER -d <db>
#                                      (same pg_dump version as the server; used for
#                                       db/schema.sql and for the production diff)
#   otherwise                         → local pg_dump "$DATABASE_URL"
# Version-dependent noise is stripped (\restrict tokens, "Dumped by/from" lines,
# transaction_timeout), so dumps from different pg_dump majors still diff cleanly.
#
set -Eeuo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/../.."

OUT="${1:-db/schema.sql}"
if [[ -z "${DATABASE_URL:-}" && -f .env.local ]]; then
  DATABASE_URL="$(grep -E '^DATABASE_URL=' .env.local | head -1 | cut -d= -f2- | tr -d "\"'")"
fi
[[ -n "${DATABASE_URL:-}" ]] || { echo "DATABASE_URL not set" >&2; exit 1; }

# database name = last path segment of the URL (without query string)
DB_NAME="${PG_DB:-}"
if [[ -z "$DB_NAME" ]]; then
  DB_NAME="$(printf '%s' "$DATABASE_URL" | sed -E 's#^[a-z]+://[^/]+/([^?]+).*#\1#')"
fi
PG_USER="${PG_USER:-postgres}"
FLAGS=(--schema-only --no-owner --no-privileges --schema=public --encoding=UTF8)

run_pg_dump() {
  if [[ -n "${PG_CONTAINER:-}" ]]; then
    docker exec "$PG_CONTAINER" pg_dump -U "$PG_USER" -d "$DB_NAME" "${FLAGS[@]}"
  else
    pg_dump "$DATABASE_URL" "${FLAGS[@]}"
  fi
}
run_psql() {
  if [[ -n "${PG_CONTAINER:-}" ]]; then
    docker exec "$PG_CONTAINER" psql -U "$PG_USER" -d "$DB_NAME" -tAc "$1"
  else
    psql "$DATABASE_URL" -tAc "$1"
  fi
}

TMP="$(mktemp)"
run_pg_dump \
  | grep -vE '^\\(un)?restrict ' \
  | grep -vE '^-- Dumped (from|by) ' \
  | grep -vE '^SET transaction_timeout' \
  > "$TMP"

# dbmate-style trailer with the applied versions (if the table exists yet)
if run_psql "select 1 from pg_tables where schemaname='public' and tablename='schema_migrations'" | grep -q 1; then
  {
    printf '\n--\n-- Dbmate schema migrations\n--\n\nINSERT INTO public.schema_migrations (version) VALUES\n'
    run_psql "select string_agg('    (''' || version || ''')', E',\n' order by version) from public.schema_migrations"
    printf ';\n'
  } >> "$TMP"
fi
mkdir -p "$(dirname "$OUT")"
mv "$TMP" "$OUT"
echo "schema written to $OUT ($(wc -l < "$OUT") lines, db=$DB_NAME)"
