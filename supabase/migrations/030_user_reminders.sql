-- 030_user_reminders.sql
-- Reminders module — standalone, user-facing reminder ITEMS. Backend only.
--
-- ADDITIVE ONLY. Creates one new table + four indexes + an updated_at trigger.
-- Idempotent (IF NOT EXISTS / DROP TRIGGER IF EXISTS). No existing table is
-- touched, no data migration.
--
-- ── Relationship to the existing public.reminders ────────────────────────────
-- public.reminders (migration 023) is a NOTIFICATION-SCHEDULING ENGINE: rows of
-- {entity_type, entity_id(uuid), user_id, remind_at, channel, sent_at} scanned
-- by the cron in src/lib/reminders/engine.ts to FIRE in-app/email notifications
-- (tasks / calendar / issues attach to it). It has no title/status/owner and is
-- fire-and-forget.
--
-- THIS table is a different concept: standalone, reviewable, assignable reminder
-- items with a lifecycle (pending → done / dismissed), soft-delete and audit.
-- It is named user_reminders (NOT reminders) precisely so it can live ALONGSIDE
-- the engine without colliding. The engine table and its cron are left untouched.
-- Wiring user_reminders into the notification engine is intentionally NOT done
-- here (spec has no channel/sent_at) — it can be added later if desired.
--
-- status / completed_at: status is text with a CHECK (project convention).
-- completed_at is DERIVED from status in the app layer (src/lib/db/userReminders.ts):
-- stamped when status enters 'done', cleared when it leaves 'done'. Never
-- client-writable. is_archived is the soft-delete flag (consistent with tasks).
--
-- Run: psql "$DIRECT_URL" -f supabase/migrations/030_user_reminders.sql

create table if not exists public.user_reminders (
  id            uuid primary key default gen_random_uuid(),
  title         text not null,
  remind_at     timestamptz not null,
  status        text not null default 'pending'
                  check (status in ('pending', 'done', 'dismissed')),
  -- Polymorphic link to any entity. Open (no rigid CHECK), text id (not uuid)
  -- so it can reference entities whose id may not be uuid. Both nullable —
  -- a reminder can be standalone (no entity).
  entity_type   text,
  entity_id     text,
  assigned_to   uuid references public.users(id) on delete set null,
  -- created_by is NOT NULL (spec). No ON DELETE clause (NO ACTION) — a user who
  -- created reminders cannot be hard-deleted while they exist; users are
  -- deactivated, not deleted, in this system.
  created_by    uuid not null references public.users(id),
  completed_at  timestamptz,
  is_archived   boolean not null default false,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

create index if not exists user_reminders_remind_at_idx on public.user_reminders (remind_at);
create index if not exists user_reminders_assigned_to_idx on public.user_reminders (assigned_to);
create index if not exists user_reminders_entity_idx on public.user_reminders (entity_type, entity_id);
create index if not exists user_reminders_status_idx on public.user_reminders (status);

drop trigger if exists user_reminders_touch_updated_at on public.user_reminders;
create trigger user_reminders_touch_updated_at
  before update on public.user_reminders
  for each row execute function public.touch_updated_at();
