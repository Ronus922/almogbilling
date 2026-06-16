-- 034_notifications_clear.sql
-- Notifications "Option A" — soft-clear semantics for the per-user stream.
--
-- ADDITIVE ONLY. Adds a single nullable column (cleared_at) to notifications and
-- one partial index over the still-active rows. No data is migrated or deleted;
-- existing rows keep cleared_at = NULL (i.e. all currently visible). Idempotent.
--
-- Behaviour (enforced in the query layer, not the schema):
--   • Active list  = rows WHERE cleared_at IS NULL
--   • Unread       = is_read = false AND cleared_at IS NULL
--   • Mark read    = is_read = true        (stays active, leaves the "unread" tab)
--   • Clear all    = cleared_at = now()    (soft-hide from ALL tabs; row kept for
--                                            audit + dedup — never a hard delete)
--
-- Run: psql "$DIRECT_URL" -f supabase/migrations/034_notifications_clear.sql

alter table public.notifications add column if not exists cleared_at timestamptz;

-- Hot path: the bell + page read only the active stream (cleared_at IS NULL),
-- per user, unread-first, newest. A partial index keeps it tight as cleared rows
-- accumulate.
create index if not exists notifications_user_active_idx
  on public.notifications (user_id, is_read, created_at desc)
  where cleared_at is null;
