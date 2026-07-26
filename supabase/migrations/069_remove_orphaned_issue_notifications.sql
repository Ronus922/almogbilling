-- 069_remove_orphaned_issue_notifications.sql
-- Cleanup: delete the notification rows that point at issues which no longer exist.
--
-- WHY THEY EXIST — different origin from 068, and NOT a live code bug.
-- All 6 are `issue_reported` notifications for 3 deliberately-created QA issues
-- (2 recipients each), and they say so themselves:
--   "בדיקת התראת אליי (זמני - למחיקה)"  16/07
--   "QA happy-path (זמני למחיקה)"       17/07
--   "QA edit-past (זמני)"               17/07
-- The test issues were removed; their notifications were not.
--
-- The app's only issue-deletion path already handles this correctly: DELETE
-- /api/issues/[id] calls deleteRemindersForEntity + deleteNotificationsForEntity
-- before deleteIssue, and deleteNotificationsForEntity matches
-- `lower(source_entity_type) = lower($1)` — so casing cannot defeat it. That fix
-- (890ed01, 06/07) predates the earliest orphan here by ten days, and
-- src/lib/db/issues.ts:deleteIssue has exactly one caller — that route. Nothing
-- else in the schema can strand these rows either: notifications has no FK to
-- issues (polymorphic source_entity_id), and the two FKs that do reference issues
-- are issue_comments (CASCADE) and tasks.issue_id (SET NULL), both clean.
-- The remaining explanation is manual removal of the QA issues outside the app
-- (direct SQL), which no application code path can guard against. It cannot be
-- proven from the data — audit_log does not record `issue` at all — so this is
-- the conclusion the evidence supports, not a certainty.
--
-- SCOPE — deletion only. Like 068, this does NOT normalize source_entity_type
-- ('Issue' 117 / 'issue' 48) and does not touch any producer; that stays a
-- separate code-side task (PROJECT_CONTEXT.md TODO). `lower(...)` is mandatory
-- regardless: all 6 orphans are on the 'Issue' side of that split.
--
-- Run (DIRECT_URL, direct port 5432):
--   psql "$DIRECT_URL" -f supabase/migrations/069_remove_orphaned_issue_notifications.sql
--
-- ROLLBACK — there is no automatic down migration. The deleted rows are dumped
-- verbatim (one JSON object per row, all columns) at
--   /var/backups/billing/069/notifications-issue-orphans.jsonl  (6 rows, root:0600)
-- Restoring is only meaningful together with the QA issues themselves, which are
-- already gone.

begin;

delete from public.notifications
 where lower(source_entity_type) = 'issue'
   and not exists (select 1 from public.issues where id = source_entity_id);

commit;

-- Idempotent: a second run deletes 0 rows.
