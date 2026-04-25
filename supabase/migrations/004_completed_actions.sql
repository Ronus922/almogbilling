-- 004_completed_actions.sql
-- Slice 3.5 — Audit trail for completed next-actions on debtors.
-- Run: docker exec -i supabase-db psql -U postgres -d proj_billing < supabase/migrations/004_completed_actions.sql

create table if not exists public.completed_actions (
  id                 uuid primary key default gen_random_uuid(),
  debtor_id          uuid not null references public.debtors(id) on delete cascade,
  apartment_number   text not null,
  description        text not null,
  due_date           date,
  completed_at       timestamptz not null default now(),
  completed_by       uuid references public.users(id),
  completed_by_name  text not null
);

create index if not exists completed_actions_debtor_idx       on public.completed_actions (debtor_id);
create index if not exists completed_actions_completed_at_idx on public.completed_actions (completed_at desc);
