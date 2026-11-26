# scripts/lib/pg-url.sh — sourced (bash), not run.
#
# A Postgres URL's password belongs in PGPASSWORD, never on a command line:
# `ps` and /proc/<pid>/cmdline show every process's arguments to every local
# account, while a process's environment is readable only by its own user and
# root (26/11/2026). psql / pg_dump read PGPASSWORD when the URL has none.
#
#   . scripts/lib/pg-url.sh
#   pg_url_split "$DATABASE_URL"     # exports PGPASSWORD (when the URL has one)
#   psql "$PG_URL" -tAc 'select 1'   # PG_URL = the same URL without its password
#
# The password is percent-decoded (libpq decodes it in a URL; PGPASSWORD is
# taken as it is). A URL without a password, or a keyword=value conninfo, is
# passed through unchanged. tests/no-secrets-on-argv.test.ts covers it.
pg_url_split() {
  local url="$1"
  local re='^([A-Za-z][A-Za-z0-9+.-]*://)([^:@/?#]*):([^@/?#]*)@(.*)$'
  PG_URL="$url"
  [[ "$url" =~ $re ]] || return 0
  local scheme="${BASH_REMATCH[1]}" user="${BASH_REMATCH[2]}" enc="${BASH_REMATCH[3]}" rest="${BASH_REMATCH[4]}"
  [[ -n "$enc" ]] || { PG_URL="${scheme}${user}@${rest}"; return 0; }
  local dec='' ch
  while [[ "$enc" =~ ^([^%]*)%([0-9A-Fa-f]{2})(.*)$ ]]; do
    dec+="${BASH_REMATCH[1]}"
    printf -v ch "\\x${BASH_REMATCH[2]}"
    dec+="$ch"
    enc="${BASH_REMATCH[3]}"
  done
  PGPASSWORD="${dec}${enc}"
  export PGPASSWORD
  PG_URL="${scheme}${user}@${rest}"
}
