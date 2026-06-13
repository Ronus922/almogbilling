#!/usr/bin/env bash
#
# scripts/test-sync-contacts.sh — end-to-end check for POST /api/sync/contacts
# (Slice 4 Track B). Mints a short-lived super_admin session directly in the DB
# (same pattern as test-contacts-api.sh), fires the sync, and verifies the
# contacts table afterwards.
#
# Outcomes:
#   - creds configured + sync runs  → asserts summary + DB counts
#   - creds NOT configured          → API returns 500 "BLLINK credentials not
#                                      configured"; that's EXPECTED → exit 0
#
# Usage: scripts/test-sync-contacts.sh   (reads .env / .env.local for DB + PORT)
set -Eeuo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."

set -a; [ -f .env ] && . ./.env; [ -f .env.local ] && . ./.env.local; set +a
DB_URL="${DIRECT_URL:-${DATABASE_URL:-}}"
BASE="http://127.0.0.1:${PORT:-3003}"
SID=""

if [[ -z "$DB_URL" ]]; then echo "FATAL: no DIRECT_URL/DATABASE_URL in env"; exit 1; fi

cleanup() {
  [[ -n "$SID" ]] && psql "$DB_URL" -tAc "delete from public.sessions where id = '$SID';" >/dev/null 2>&1 || true
}
trap cleanup EXIT

# --- mint super_admin session ----------------------------------------------
ADMIN_ID="$(psql "$DB_URL" -tAc "select id from public.users where role in ('super_admin','admin') and is_active order by created_at limit 1;")"
if [[ -z "$ADMIN_ID" ]]; then echo "FATAL: no active admin user found"; exit 1; fi
SID="$(openssl rand -base64 32 | tr '+/' '-_' | tr -d '=')"
psql "$DB_URL" -tAc "insert into public.sessions (id, user_id, expires_at, remember) values ('$SID', '$ADMIN_ID', now() + interval '10 minutes', false);" >/dev/null
COOKIE="almog_sid=$SID"
echo "session minted for admin $ADMIN_ID"

# --- fire the sync ----------------------------------------------------------
echo "POST /api/sync/contacts ..."
RESP=$(curl -s -w $'\n%{http_code}' -X POST "$BASE/api/sync/contacts" -H "Cookie: $COOKIE")
CODE=$(tail -n1 <<<"$RESP")
JSON=$(sed '$d' <<<"$RESP")
echo "  HTTP $CODE"
echo "  body: $JSON"

# --- expected no-credentials path ------------------------------------------
if [[ "$CODE" == "500" ]] && grep -q "BLLINK credentials not configured" <<<"$JSON"; then
  echo ""
  echo "==> EXPECTED: BLLINK credentials not configured — sync skipped. (exit 0)"
  exit 0
fi

if [[ "$CODE" != "200" ]]; then
  echo "✗ unexpected status $CODE"
  exit 1
fi

# --- sync ran — verify DB ---------------------------------------------------
CREATED=$(grep -o '"created":[0-9]*' <<<"$JSON" | head -1 | grep -o '[0-9]*')
echo ""
echo "DB after sync:"
psql "$DB_URL" -c "SELECT count(*) AS total, count(*) FILTER (WHERE owner_name IS NOT NULL) AS with_owner_name, count(*) FILTER (WHERE last_synced_at IS NOT NULL) AS synced FROM contacts;"

TOTAL=$(psql "$DB_URL" -tAc "SELECT count(*) FROM contacts;")
echo "contacts total = $TOTAL, summary.created = ${CREATED:-?}"

if [[ "${CREATED:-0}" -gt 0 && "${TOTAL:-0}" -eq 0 ]]; then
  echo "✗ ERROR: summary.created>0 but contacts table is empty"
  exit 1
fi

echo ""
echo "==> sync completed end-to-end."
