-- 013_debtor_events.sql
-- Unified timeline — generic event log for the debtor panel "היסטוריה" tab.
-- Captures manual documentation (calls / SMS / WhatsApp / email / meeting / other)
-- and automatic system events (archive / unarchive / future warning-letter etc).
-- Status changes are NOT logged here — they already live in legal_status_history.
-- actor_* are snapshots (NOT foreign keys), mirroring completed_actions: the row
-- must survive even if the user is later deleted.
-- Run: docker exec -i supabase-db psql -U postgres -d proj_billing < supabase/migrations/013_debtor_events.sql

create table if not exists public.debtor_events (
  id           uuid primary key default gen_random_uuid(),
  debtor_id    uuid not null references public.debtors(id) on delete cascade,
  event_type   text not null check (event_type in (
                 'PHONE_CALL','SMS','WHATSAPP','EMAIL','MEETING',
                 'ARCHIVE','UNARCHIVE','WARNING_LETTER','LEGAL_PROCEEDING',
                 'SYSTEM','OTHER')),
  title        text not null,
  description  text,
  outcome      text,
  metadata     jsonb not null default '{}',
  actor_id     uuid,
  actor_name   text,
  actor_email  text,
  created_at   timestamptz not null default now()
);

create index if not exists debtor_events_debtor_created_idx
  on public.debtor_events (debtor_id, created_at desc);
create index if not exists debtor_events_type_idx
  on public.debtor_events (event_type);
