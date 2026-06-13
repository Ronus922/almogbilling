#!/usr/bin/env bash
#
# scripts/test-contacts-import.sh — end-to-end test for the contacts Excel import
# (Slice 4 Track C). Mints a super_admin session in-DB, builds a small workbook
# with SheetJS (covering '000000000', empty cells, a no-apartment row, a
# duplicate row, and an empty-phone clobber case), POSTs it, polls the status,
# and asserts the counters + the "empty never clobbers" rule. Self-cleaning.
#
# Usage: scripts/test-contacts-import.sh   (reads .env / .env.local for DB + PORT)
set -Eeuo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."

set -a; [ -f .env ] && . ./.env; [ -f .env.local ] && . ./.env.local; set +a
DB_URL="${DIRECT_URL:-${DATABASE_URL:-}}"
BASE="http://127.0.0.1:${PORT:-3003}"
XLSX_FILE="/tmp/test-contacts-import-$$.xlsx"
APTS="('970001','970002','970003','970099')"
SID=""

if [[ -z "$DB_URL" ]]; then echo "FATAL: no DIRECT_URL/DATABASE_URL in env"; exit 1; fi

pass=0; fail=0
check() { if [[ "$2" == "$3" ]]; then echo "  ✓ $1 → $2"; pass=$((pass+1)); else echo "  ✗ $1 → got $2, expected $3"; fail=$((fail+1)); fi; }

cleanup() {
  [[ -n "$SID" ]] && psql "$DB_URL" -tAc "delete from public.sessions where id = '$SID';" >/dev/null 2>&1 || true
  psql "$DB_URL" -tAc "delete from public.contacts where apartment_number in $APTS;" >/dev/null 2>&1 || true
  rm -f "$XLSX_FILE" 2>/dev/null || true
}
trap cleanup EXIT

# --- mint session -----------------------------------------------------------
ADMIN_ID="$(psql "$DB_URL" -tAc "select id from public.users where role in ('super_admin','admin') and is_active order by created_at limit 1;")"
[[ -z "$ADMIN_ID" ]] && { echo "FATAL: no admin user"; exit 1; }
SID="$(openssl rand -base64 32 | tr '+/' '-_' | tr -d '=')"
psql "$DB_URL" -tAc "insert into public.sessions (id, user_id, expires_at, remember) values ('$SID', '$ADMIN_ID', now() + interval '10 minutes', false);" >/dev/null
COOKIE="almog_sid=$SID"

# clean slate + pre-seed the clobber row (970099 with a real owner_phone)
psql "$DB_URL" -tAc "delete from public.contacts where apartment_number in $APTS;" >/dev/null
psql "$DB_URL" -tAc "insert into public.contacts (apartment_number, owner_name, owner_phone, notes) values ('970099','קלובר מקורי','0501234567','הערה ידנית');" >/dev/null
echo "pre-seeded 970099 with owner_phone=0501234567 + manual note"

# --- build the workbook with SheetJS ----------------------------------------
XLSX_OUT="$XLSX_FILE" node -e '
const XLSX = require("xlsx");
const rows = [
  ["דירה","שם בעלים","טלפון בעלים","אימייל בעלים","שם שוכר","טלפון שוכר","אימייל שוכר","תשלום חודשי"],
  ["970001","בעלים א","0501111111","a@x.com","שוכר א","0521111111","ta@x.com",350],
  ["970002","בעלים ב","000000000","","","","",350],          // owner_phone placeholder → null
  ["970003","בעלים ג","","","","","",350],                    // only apt + name
  ["","שם בלי דירה","0500000000","","","","",350],            // no apartment → skipped
  ["970001","בעלים א מעודכן","0509999999","","","","",400],   // duplicate apt → update
  ["970099","בעלים קלובר","","c@x.com","","","",350],         // empty owner_phone → must NOT clobber
];
const ws = XLSX.utils.aoa_to_sheet(rows);
const wb = XLSX.utils.book_new();
XLSX.utils.book_append_sheet(wb, ws, "Sheet1");
XLSX.writeFile(wb, process.env.XLSX_OUT);
'
echo "built workbook: $XLSX_FILE"

# --- POST the import --------------------------------------------------------
POST=$(curl -s -w $'\n%{http_code}' -X POST "$BASE/api/contacts/import" -H "Cookie: $COOKIE" -F "file=@$XLSX_FILE")
CODE=$(tail -n1 <<<"$POST"); JSON=$(sed '$d' <<<"$POST")
check "POST status" "$CODE" "201"
RUNID=$(grep -o '"runId":"[^"]*"' <<<"$JSON" | head -1 | sed 's/"runId":"//; s/"//')
echo "  runId: $RUNID"
[[ -n "$RUNID" ]] && check "has runId" yes yes || check "has runId" no yes

# --- poll status ------------------------------------------------------------
STATUS=""; SJSON=""
for _ in $(seq 1 60); do
  SJSON=$(curl -s "$BASE/api/contacts/import/status/$RUNID" -H "Cookie: $COOKIE")
  STATUS=$(grep -o '"status":"[^"]*"' <<<"$SJSON" | head -1 | sed 's/"status":"//; s/"//')
  case "$STATUS" in running|parsing|processing) sleep 0.5 ;; *) break ;; esac
done
echo "  final status: $STATUS"
echo "  status body: $SJSON"
check "terminal status is completed" "$STATUS" "completed"

g() { grep -o "\"$1\":[0-9]*" <<<"$SJSON" | head -1 | grep -o '[0-9]*'; }
check "total_rows" "$(g total_rows)" "6"
check "created"    "$(g created)"    "3"
check "updated"    "$(g updated)"    "2"
check "skipped"    "$(g skipped)"    "1"
check "failed"     "$(g failed)"     "0"

# --- DB assertions ----------------------------------------------------------
echo "DB checks:"
check "970099 owner_phone preserved (empty did NOT clobber)" \
  "$(psql "$DB_URL" -tAc "select owner_phone from public.contacts where apartment_number='970099';")" \
  "0501234567"
check "970099 manual note untouched (not in allowedFields)" \
  "$(psql "$DB_URL" -tAc "select notes from public.contacts where apartment_number='970099';")" \
  "הערה ידנית"
check "970002 owner_phone is NULL ('000000000' filtered)" \
  "$(psql "$DB_URL" -tAc "select coalesce(owner_phone,'<null>') from public.contacts where apartment_number='970002';")" \
  "<null>"
check "970001 owner_name updated by duplicate row" \
  "$(psql "$DB_URL" -tAc "select owner_name from public.contacts where apartment_number='970001';")" \
  "בעלים א מעודכן"
check "no-apartment row not inserted (total test rows = 4)" \
  "$(psql "$DB_URL" -tAc "select count(*) from public.contacts where apartment_number in $APTS;")" \
  "4"

# --- runs history endpoint --------------------------------------------------
RUNS=$(curl -s "$BASE/api/contacts/import/runs" -H "Cookie: $COOKIE")
grep -q "\"$RUNID\"" <<<"$RUNS" && check "runs history lists this run" yes yes || check "runs history lists this run" no yes

echo ""
echo "==== $pass passed, $fail failed ===="
[[ "$fail" -eq 0 ]]
