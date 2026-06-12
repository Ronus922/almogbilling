#!/usr/bin/env bash
#
# scripts/test-contacts-api.sh — end-to-end smoke test for the Contacts CRUD API
# (Slice 4 Track A). Exercises: login → POST → GET list → GET by id → PATCH →
# DELETE → GET list (gone).
#
# "Login" here mints a short-lived session row directly in public.sessions for
# an existing active admin user and uses it as the `almog_sid` cookie — this
# avoids needing a plaintext password and the login rate-limiter, and is torn
# down on exit. The created test contact uses a sentinel apartment number and is
# cleaned up too, so the script is safe to re-run.
#
# Usage: scripts/test-contacts-api.sh   (reads .env / .env.local for DB + PORT)
set -Eeuo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."

# --- env --------------------------------------------------------------------
set -a; [ -f .env ] && . ./.env; [ -f .env.local ] && . ./.env.local; set +a
DB_URL="${DIRECT_URL:-${DATABASE_URL:-}}"
BASE="http://127.0.0.1:${PORT:-3003}"
TEST_APT="990042"          # sentinel apartment number for this test
COOKIE=""                  # session id we mint
SID=""

if [[ -z "$DB_URL" ]]; then echo "FATAL: no DIRECT_URL/DATABASE_URL in env"; exit 1; fi

pass=0; fail=0
check() { # check <label> <actual> <expected>
  if [[ "$2" == "$3" ]]; then echo "  ✓ $1 → $2"; pass=$((pass+1));
  else echo "  ✗ $1 → got $2, expected $3"; fail=$((fail+1)); fi
}

cleanup() {
  [[ -n "$SID" ]] && psql "$DB_URL" -tAc "delete from public.sessions where id = '$SID';" >/dev/null 2>&1 || true
  psql "$DB_URL" -tAc "delete from public.contacts where apartment_number = '$TEST_APT';" >/dev/null 2>&1 || true
}
trap cleanup EXIT

# --- 0) mint admin session (the "login") ------------------------------------
echo "0) login (mint admin session)"
ADMIN_ID="$(psql "$DB_URL" -tAc "select id from public.users where role in ('super_admin','admin') and is_active order by created_at limit 1;")"
if [[ -z "$ADMIN_ID" ]]; then echo "FATAL: no active admin user found"; exit 1; fi
SID="$(openssl rand -base64 32 | tr '+/' '-_' | tr -d '=')"
psql "$DB_URL" -tAc "insert into public.sessions (id, user_id, expires_at, remember) values ('$SID', '$ADMIN_ID', now() + interval '10 minutes', false);" >/dev/null
COOKIE="almog_sid=$SID"
echo "  ✓ session minted for admin $ADMIN_ID"

# pre-clean any leftover test contact from a previous failed run
psql "$DB_URL" -tAc "delete from public.contacts where apartment_number = '$TEST_APT';" >/dev/null 2>&1 || true

req() { # req METHOD PATH [json-body]  → prints "BODY\nCODE"
  local m="$1" p="$2" b="${3:-}"
  if [[ -n "$b" ]]; then
    curl -s -w $'\n%{http_code}' -X "$m" "$BASE$p" -H "Cookie: $COOKIE" \
      -H 'Content-Type: application/json' -d "$b"
  else
    curl -s -w $'\n%{http_code}' -X "$m" "$BASE$p" -H "Cookie: $COOKIE"
  fi
}

# --- 1) POST /api/contacts --------------------------------------------------
echo "1) POST /api/contacts"
BODY=$(req POST /api/contacts "{\"apartment_number\":\"$TEST_APT\",\"owner_name\":\"בדיקה אוטומטית\",\"owner_phone\":\"0501234567\",\"owner_email\":\"test@example.com\",\"resident_type\":\"owner\",\"tags\":[\"vip\",\"בדיקה\"]}")
CODE=$(tail -n1 <<<"$BODY"); JSON=$(sed '$d' <<<"$BODY")
check "status" "$CODE" "201"
CID=$(grep -o '"id":"[^"]*"' <<<"$JSON" | head -1 | sed 's/"id":"//; s/"//')
echo "  contact id: $CID"
[[ -n "$CID" ]] && check "has id" "yes" "yes" || check "has id" "no" "yes"

# duplicate apartment → 409
echo "1b) POST duplicate apartment → 409"
DUP=$(req POST /api/contacts "{\"apartment_number\":\"$TEST_APT\"}")
check "status" "$(tail -n1 <<<"$DUP")" "409"

# invalid body (missing apartment_number) → 400
echo "1c) POST invalid (no apartment_number) → 400"
BAD=$(req POST /api/contacts "{\"owner_name\":\"x\"}")
check "status" "$(tail -n1 <<<"$BAD")" "400"

# --- 2) GET /api/contacts (list) --------------------------------------------
echo "2) GET /api/contacts (list)"
LIST=$(req GET "/api/contacts?search=$TEST_APT")
check "status" "$(tail -n1 <<<"$LIST")" "200"
sed '$d' <<<"$LIST" | grep -q "\"$TEST_APT\"" && check "contains test apt" "yes" "yes" || check "contains test apt" "no" "yes"

# --- 3) GET /api/contacts/[id] ----------------------------------------------
echo "3) GET /api/contacts/$CID"
ONE=$(req GET "/api/contacts/$CID")
check "status" "$(tail -n1 <<<"$ONE")" "200"

# --- 4) PATCH /api/contacts/[id] --------------------------------------------
echo "4) PATCH /api/contacts/$CID"
PATCHED=$(req PATCH "/api/contacts/$CID" "{\"notes\":\"עודכן בבדיקה\",\"apartment_number\":\"111111\"}")
check "status" "$(tail -n1 <<<"$PATCHED")" "200"
PJSON=$(sed '$d' <<<"$PATCHED")
grep -q "עודכן בבדיקה" <<<"$PJSON" && check "notes updated" "yes" "yes" || check "notes updated" "no" "yes"
grep -q "\"$TEST_APT\"" <<<"$PJSON" && check "apartment immutable" "yes" "yes" || check "apartment immutable" "no" "yes"

# --- 5) DELETE /api/contacts/[id] -------------------------------------------
echo "5) DELETE /api/contacts/$CID"
DEL=$(curl -s -o /dev/null -w '%{http_code}' -X DELETE "$BASE/api/contacts/$CID" -H "Cookie: $COOKIE")
check "status" "$DEL" "204"
DEL2=$(curl -s -o /dev/null -w '%{http_code}' -X DELETE "$BASE/api/contacts/$CID" -H "Cookie: $COOKIE")
check "delete again → 404" "$DEL2" "404"

# --- 6) GET list again (test contact gone) ----------------------------------
echo "6) GET /api/contacts (test contact gone)"
LIST2=$(req GET "/api/contacts?search=$TEST_APT")
check "status" "$(tail -n1 <<<"$LIST2")" "200"
sed '$d' <<<"$LIST2" | grep -q "\"$TEST_APT\"" && check "test apt absent" "present" "absent" || check "test apt absent" "absent" "absent"

# --- 7) unauthenticated GET → 401 -------------------------------------------
echo "7) GET /api/contacts without cookie → 401"
UNAUTH=$(curl -s -o /dev/null -w '%{http_code}' "$BASE/api/contacts")
check "status" "$UNAUTH" "401"

echo ""
echo "==== RESULT: $pass passed, $fail failed ===="
[[ "$fail" -eq 0 ]]
