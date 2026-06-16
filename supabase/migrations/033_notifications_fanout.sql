-- 033_notifications_fanout.sql
-- Notifications module — additive schema for the per-user notification stream
-- (bell popover + /notifications page) and the multi-channel fan-out
-- (in-app + email + gated WhatsApp).
--
-- ADDITIVE ONLY. The notifications table already exists (migration 023); this
-- migration only ADDs a `read_at` column to it, adds three opt-in columns to
-- users, and adds one covering index. Every statement is guarded
-- (IF NOT EXISTS / DO-block) so the file is fully idempotent and safe to re-run.
--
-- Run: psql "$DIRECT_URL" -f supabase/migrations/033_notifications_fanout.sql

-- ─────────────────────────────────────────────────────────────────────────
-- 1. notifications — defensive baseline + read_at.
--    The table + most columns already exist (023). CREATE IF NOT EXISTS makes a
--    fresh DB match the contract; the ALTERs are no-ops where the column exists.
-- ─────────────────────────────────────────────────────────────────────────
create table if not exists public.notifications (
  id                  uuid primary key default gen_random_uuid(),
  user_id             uuid not null,
  type                text not null,
  title               text,
  message             text not null,
  is_read             boolean not null default false,
  read_at             timestamptz,
  source_module       text,
  source_entity_type  text,
  source_entity_id    text,
  action_url          text,
  priority            text not null default 'normal',
  dedupe_key          text,
  created_at          timestamptz not null default now()
);

alter table public.notifications add column if not exists title              text;
alter table public.notifications add column if not exists read_at            timestamptz;
alter table public.notifications add column if not exists source_module      text;
alter table public.notifications add column if not exists source_entity_type text;
alter table public.notifications add column if not exists source_entity_id   text;
alter table public.notifications add column if not exists action_url         text;
alter table public.notifications add column if not exists priority           text not null default 'normal';
alter table public.notifications add column if not exists dedupe_key         text;

-- FK to users — created only if missing (023 already established it).
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'notifications_user_id_fkey') then
    alter table public.notifications add constraint notifications_user_id_fkey
      foreign key (user_id) references public.users(id) on delete cascade;
  end if;
end $$;

-- Partial unique dedupe index — create only if NO unique index already covers
-- dedupe_key (023 created it as notifications_dedupe_key_uidx). Avoids a
-- redundant duplicate index while still self-provisioning a fresh DB.
do $$ begin
  if not exists (
    select 1 from pg_indexes
     where schemaname = 'public' and tablename = 'notifications'
       and indexdef ilike '%unique%' and indexdef ilike '%dedupe_key%'
  ) then
    create unique index notifications_dedupe_key_uq
      on public.notifications (dedupe_key) where dedupe_key is not null;
  end if;
end $$;

-- Covering index for the hot unread-stream read (per user, unread-first, newest).
create index if not exists notifications_user_unread_idx
  on public.notifications (user_id, is_read, created_at desc);

-- ─────────────────────────────────────────────────────────────────────────
-- 2. users — per-user notification preferences (opt-in fan-out).
--    notify_email defaults ON (everyone already gets task/issue mail today);
--    notify_whatsapp defaults OFF and notification_phone defaults NULL, so NO
--    one receives a WhatsApp notification until an admin opts them in + enters a
--    number. This is the safety gate the fan-out relies on.
-- ─────────────────────────────────────────────────────────────────────────
alter table public.users add column if not exists notification_phone text;
alter table public.users add column if not exists notify_email    boolean not null default true;
alter table public.users add column if not exists notify_whatsapp boolean not null default false;
