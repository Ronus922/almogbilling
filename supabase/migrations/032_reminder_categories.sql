-- 032_reminder_categories.sql
-- Reminders module — categories. Extends the user-facing reminder ITEMS table
-- (migration 030, public.user_reminders) with a user-defined, colored category
-- taxonomy. Backend + UI ship in the same session.
--
-- SERIAL NOTE: the source request labelled this "033", but the last applied
-- migration is 031 (031_documents.sql) — the actual next serial is 032. The
-- repo convention is strictly sequential with NO gaps (024…031), so this file
-- is 032 to avoid leaving a phantom 032. (No migration has run yet; rename is
-- trivial if 033 is ever truly wanted.)
--
-- ADDITIVE ONLY. Creates one new table + indexes + an updated_at trigger, and
-- adds ONE nullable column (+ index) to public.user_reminders. Idempotent
-- (IF NOT EXISTS / ADD COLUMN IF NOT EXISTS / DROP TRIGGER IF EXISTS). No data
-- migration, no drops, no backfill — existing reminders keep category_id NULL.
--
-- ── Design ───────────────────────────────────────────────────────────────────
-- reminder_categories: a colored label a user attaches to reminders. `color` is
-- a hex string ('#RRGGBB') chosen by the user in the UI — it is DATA, not a
-- design token (DESIGN.md tokens govern the chrome; the swatch fill comes from
-- this column, rendered with inline style, exactly like statuses.color §2).
-- created_by tracks ownership (audit) but does NOT scope visibility: categories
-- are an org-wide shared taxonomy (any user can file a reminder under any
-- category), mirroring how reminders themselves cross users via assigned_to.
-- display_order lets the UI order them; is_archived is the soft-delete flag
-- (consistent with tasks / user_reminders / documents).
--
-- ── FK / on-delete rationale ─────────────────────────────────────────────────
--   • reminder_categories.created_by → users(id), NOT NULL, NO on-delete clause
--     (NO ACTION). Mirrors user_reminders: users are deactivated, never
--     hard-deleted, so a creator cannot vanish while their rows exist.
--   • user_reminders.category_id → reminder_categories(id) ON DELETE SET NULL —
--     a hard-deleted category floats its reminders back to "uncategorized"
--     rather than destroying reminder rows. Soft-delete (is_archived) is the
--     normal path; this only guards accidental hard deletes.
--
-- Run: psql "$DIRECT_URL" -f supabase/migrations/032_reminder_categories.sql

begin;

-- ── Categories ───────────────────────────────────────────────────────────────
create table if not exists public.reminder_categories (
  id            uuid primary key default gen_random_uuid(),
  name          text not null,
  -- User-chosen hex color ('#3D5AFE'). Validated app-side (COLOR_HEX_RE);
  -- stored as data, rendered with inline style in the UI.
  color         text not null,
  created_by    uuid not null references public.users(id),
  display_order int  not null default 0,
  is_archived   boolean not null default false,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

create index if not exists reminder_categories_created_by_idx
  on public.reminder_categories (created_by);
create index if not exists reminder_categories_order_idx
  on public.reminder_categories (display_order, name);

drop trigger if exists reminder_categories_touch_updated_at on public.reminder_categories;
create trigger reminder_categories_touch_updated_at
  before update on public.reminder_categories
  for each row execute function public.touch_updated_at();

-- ── Link column on user_reminders ────────────────────────────────────────────
alter table public.user_reminders
  add column if not exists category_id uuid
    references public.reminder_categories(id) on delete set null;

create index if not exists user_reminders_category_idx
  on public.user_reminders (category_id);

commit;
