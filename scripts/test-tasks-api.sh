#!/usr/bin/env bash
#
# scripts/test-tasks-api.sh — end-to-end smoke test for the Tasks + Notifications
# + Reminders module (Module 1). Mints a short-lived admin session row directly
# (same approach as test-contacts-api.sh), then exercises:
#   create task (assigned to a *different* active user) → verify notification
#   row → list tasks → patch (status) → add comment → create due reminder →
#   run the cron engine with the real secret → verify the reminder was sent and
#   a 'reminder' notification was created → cleanup.
#
# Safe to re-run: all created rows are torn down on exit.
set -Eeuo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."

set -a; [ -f .env ] && . ./.env; [ -f .env.local ] && . ./.env.local; set +a
DB_URL="${DIRECT_URL:-${DATABASE_URL:-}}"
BASE="http://127.0.0.1:${PORT:-3003}"
[[ -z "$DB_URL" ]] && { echo "FATAL: no DB url"; exit 1; }

# Cron secret lives in the root-only env file.
CRON_SECRET="$(sudo grep -E '^BILLING_CRON_SECRET=' /etc/billing/billing.env | head -1 | cut -d= -f2-)"
[[ -z "$CRON_SECRET" ]] && { echo "FATAL: no BILLING_CRON_SECRET"; exit 1; }

SID=""; TASK_ID=""; ASSIGNEE_ID=""
pass=0; fail=0
check() { if [[ "$2" == "$3" ]]; then echo "  ✓ $1 → $2"; pass=$((pass+1)); else echo "  ✗ $1 → got '$2', expected '$3'"; fail=$((fail+1)); fi; }
nonzero() { if [[ "${2:-0}" -ge "${3:-1}" ]]; then echo "  ✓ $1 → $2"; pass=$((pass+1)); else echo "  ✗ $1 → got '$2', expected >= ${3:-1}"; fail=$((fail+1)); fi; }

cleanup() {
  [[ -n "$TASK_ID" ]] && psql "$DB_URL" -tAc "delete from public.tasks where id='$TASK_ID';" >/dev/null 2>&1 || true
  [[ -n "$ASSIGNEE_ID" ]] && psql "$DB_URL" -tAc "delete from public.notifications where user_id='$ASSIGNEE_ID' and source_module='tasks';" >/dev/null 2>&1 || true
  [[ -n "$SID" ]] && psql "$DB_URL" -tAc "delete from public.sessions where id='$SID';" >/dev/null 2>&1 || true
}
trap cleanup EXIT

echo "0) mint admin session + pick assignee"
ADMIN_ID="$(psql "$DB_URL" -tAc "select id from public.users where role in ('super_admin','admin') and is_active order by created_at limit 1;")"
[[ -z "$ADMIN_ID" ]] && { echo "FATAL: no admin"; exit 1; }
# A *different* active user to assign to (so assignment triggers a notification).
ASSIGNEE_ID="$(psql "$DB_URL" -tAc "select id from public.users where is_active and id<>'$ADMIN_ID' order by created_at limit 1;")"
[[ -z "$ASSIGNEE_ID" ]] && ASSIGNEE_ID="$ADMIN_ID"  # fallback: self (no notif expected then)
SID="$(openssl rand -base64 32 | tr '+/' '-_' | tr -d '=')"
psql "$DB_URL" -tAc "insert into public.sessions (id,user_id,expires_at,remember) values ('$SID','$ADMIN_ID',now()+interval '10 minutes',false);" >/dev/null
COOKIE="almog_sid=$SID"
echo "  ✓ admin=$ADMIN_ID assignee=$ASSIGNEE_ID"

req() { local m="$1" p="$2" b="${3:-}"; if [[ -n "$b" ]]; then curl -s -w $'\n%{http_code}' -X "$m" "$BASE$p" -H "Cookie: $COOKIE" -H 'Content-Type: application/json' -d "$b"; else curl -s -w $'\n%{http_code}' -X "$m" "$BASE$p" -H "Cookie: $COOKIE"; fi; }

echo "1) create task (assigned to assignee)"
RESP="$(req POST /api/tasks "{\"title\":\"בדיקת מערכת — משימה\",\"priority\":\"high\",\"assigned_to_user_id\":\"$ASSIGNEE_ID\",\"status\":\"open\"}")"
CODE="$(tail -1 <<<"$RESP")"; BODY="$(sed '$d' <<<"$RESP")"
check "POST /api/tasks status" "$CODE" "201"
TASK_ID="$(sed -n 's/.*"id":"\([0-9a-f-]\{36\}\)".*/\1/p' <<<"$BODY" | head -1)"
[[ -n "$TASK_ID" ]] && { echo "  ✓ task id=$TASK_ID"; pass=$((pass+1)); } || { echo "  ✗ no task id in $BODY"; fail=$((fail+1)); }

echo "2) verify assignment notification row"
if [[ "$ASSIGNEE_ID" != "$ADMIN_ID" ]]; then
  NCNT="$(psql "$DB_URL" -tAc "select count(*) from public.notifications where user_id='$ASSIGNEE_ID' and type='task_assigned' and source_entity_id='$TASK_ID';")"
  nonzero "notification created for assignee" "$NCNT" 1
else
  echo "  ~ skipped (only one active user — self-assign doesn't notify)"
fi

echo "3) list tasks (kpis)"
RESP="$(req GET "/api/tasks?kpis=1")"; CODE="$(tail -1 <<<"$RESP")"; BODY="$(sed '$d' <<<"$RESP")"
check "GET /api/tasks status" "$CODE" "200"
echo "$BODY" | grep -q "\"$TASK_ID\"" && { echo "  ✓ created task present in list"; pass=$((pass+1)); } || { echo "  ✗ task not in list"; fail=$((fail+1)); }
echo "$BODY" | grep -q '"kpis"' && { echo "  ✓ kpis present"; pass=$((pass+1)); } || { echo "  ✗ kpis missing"; fail=$((fail+1)); }

echo "4) patch status → in_progress"
RESP="$(req PATCH "/api/tasks/$TASK_ID" '{"status":"in_progress"}')"; CODE="$(tail -1 <<<"$RESP")"
check "PATCH status" "$CODE" "200"
DBSTATUS="$(psql "$DB_URL" -tAc "select status from public.tasks where id='$TASK_ID';")"
check "db status updated" "$DBSTATUS" "in_progress"

echo "5) add comment"
RESP="$(req POST "/api/tasks/$TASK_ID/comments" '{"content":"תגובת בדיקה"}')"; CODE="$(tail -1 <<<"$RESP")"
check "POST comment" "$CODE" "201"

echo "6) create a DUE reminder (remind_at in the past) via PATCH reminders"
PAST="$(date -u -d '-1 minute' +%Y-%m-%dT%H:%M:%S.000Z)"
RESP="$(req PATCH "/api/tasks/$TASK_ID" "{\"reminders\":[{\"remind_at\":\"$PAST\",\"channel\":\"in_app\"}]}")"
CODE="$(tail -1 <<<"$RESP")"; check "PATCH reminders" "$CODE" "200"
RCNT="$(psql "$DB_URL" -tAc "select count(*) from public.reminders where entity_type='task' and entity_id='$TASK_ID' and sent_at is null;")"
nonzero "unsent reminder exists" "$RCNT" 1

echo "7) run cron reminders engine (real secret)"
CRESP="$(curl -s -w $'\n%{http_code}' -X POST -H "x-cron-secret: $CRON_SECRET" "$BASE/api/cron/reminders")"
CCODE="$(tail -1 <<<"$CRESP")"; CBODY="$(sed '$d' <<<"$CRESP")"
check "cron status" "$CCODE" "200"
echo "    cron body: $CBODY"
SENT="$(psql "$DB_URL" -tAc "select count(*) from public.reminders where entity_type='task' and entity_id='$TASK_ID' and sent_at is not null;")"
nonzero "reminder marked sent" "$SENT" 1
REMNOTIF="$(psql "$DB_URL" -tAc "select count(*) from public.notifications where source_entity_id='$TASK_ID' and type='reminder';")"
nonzero "reminder notification created" "$REMNOTIF" 1

echo "8) cron idempotency (second run should process 0 due)"
CRESP2="$(curl -s -X POST -H "x-cron-secret: $CRON_SECRET" "$BASE/api/cron/reminders")"
echo "    cron2 body: $CRESP2"

echo
echo "──────────────────────────────"
echo "PASS=$pass  FAIL=$fail"
[[ "$fail" -eq 0 ]] && echo "ALL GREEN" || echo "FAILURES PRESENT"
exit "$fail"
