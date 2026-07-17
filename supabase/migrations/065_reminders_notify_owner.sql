-- 065_reminders_notify_owner.sql
-- Reminders — add the "אליי"/self opt-in flag.
--
-- ADDITIVE ONLY. Adds ONE boolean column (NOT NULL DEFAULT false) to the
-- existing public.reminders table. No new tables, constraints, triggers or
-- indexes; ZERO change to any existing column. Existing rows receive `false`
-- automatically via the default → no backfill, no meaningful lock.
-- Idempotent (ADD COLUMN IF NOT EXISTS) — safe to re-run.
--
-- Purpose: the reminder engine resolves recipients at fire time from the
-- entity's CURRENT user-assignees (falling back to the owner only when there are
-- none). When notify_owner is true, the engine ALSO unions the row owner
-- (user_id) into the recipient set — i.e. the reporter/creator ("אליי") receives
-- the scheduled reminder on the reminder's channels even when handlers exist.
-- Off (false) keeps today's behaviour exactly.
--
-- Run: psql "$DIRECT_URL" -f supabase/migrations/065_reminders_notify_owner.sql

-- UP
alter table public.reminders
  add column if not exists notify_owner boolean not null default false;
comment on column public.reminders.notify_owner is
  'When true, the reminder engine also notifies the row owner (user_id) — the "אליי"/self opt-in — in addition to the entity assignees.';

-- DOWN
-- alter table public.reminders drop column if exists notify_owner;
