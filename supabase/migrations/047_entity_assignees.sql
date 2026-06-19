-- 047_entity_assignees.sql
-- Full mixed Multi-Assignee — replace the single user-XOR-supplier handler on
-- tasks & issues with a polymorphic junction that holds N users + M suppliers
-- simultaneously.
--
-- ADDITIVE: the legacy scalar columns tasks.assigned_to_user_id / tasks.supplier_id
-- and issues.assigned_to_user_id / issues.supplier_id are NOT dropped here — they
-- are backfilled FROM and then frozen (the app reads/writes only the junction).
-- Dropping them is a deliberate future wave. Idempotent (IF NOT EXISTS + ON
-- CONFLICT DO NOTHING) — safe to re-run.
--
-- Run: psql "$DIRECT_URL" -f supabase/migrations/047_entity_assignees.sql

begin;

create table if not exists public.entity_assignees (
  id            uuid primary key default gen_random_uuid(),
  entity_type   text not null check (entity_type in ('task', 'issue')),
  entity_id     uuid not null,
  assignee_type text not null check (assignee_type in ('user', 'supplier')),
  user_id       uuid references public.users(id)     on delete cascade,
  supplier_id   uuid references public.suppliers(id) on delete cascade,
  created_at    timestamptz not null default now(),
  created_by    uuid references public.users(id)     on delete set null,
  -- exactly one target, matching assignee_type
  constraint entity_assignees_one_target check (
    (assignee_type = 'user'     and user_id     is not null and supplier_id is null) or
    (assignee_type = 'supplier' and supplier_id is not null and user_id     is null)
  )
);

-- No duplicate assignee per entity. coalesce(user_id, supplier_id) is the actual
-- target id (exactly one is non-null); a literal UNIQUE(...,user_id,supplier_id)
-- would NOT dedupe because NULLs compare distinct.
create unique index if not exists entity_assignees_uniq
  on public.entity_assignees (entity_type, entity_id, assignee_type, coalesce(user_id, supplier_id));

create index if not exists entity_assignees_entity_idx
  on public.entity_assignees (entity_type, entity_id);
create index if not exists entity_assignees_user_idx
  on public.entity_assignees (user_id) where user_id is not null;
create index if not exists entity_assignees_supplier_idx
  on public.entity_assignees (supplier_id) where supplier_id is not null;

-- ── Backfill from the legacy scalar columns (at most one of each per row today) ──
insert into public.entity_assignees (entity_type, entity_id, assignee_type, user_id, supplier_id, created_by)
select 'task', t.id, 'user', t.assigned_to_user_id, null, t.created_by
  from public.tasks t
 where t.assigned_to_user_id is not null
on conflict do nothing;

insert into public.entity_assignees (entity_type, entity_id, assignee_type, user_id, supplier_id, created_by)
select 'task', t.id, 'supplier', null, t.supplier_id, t.created_by
  from public.tasks t
 where t.supplier_id is not null
on conflict do nothing;

insert into public.entity_assignees (entity_type, entity_id, assignee_type, user_id, supplier_id, created_by)
select 'issue', i.id, 'user', i.assigned_to_user_id, null, i.created_by
  from public.issues i
 where i.assigned_to_user_id is not null
on conflict do nothing;

insert into public.entity_assignees (entity_type, entity_id, assignee_type, user_id, supplier_id, created_by)
select 'issue', i.id, 'supplier', null, i.supplier_id, i.created_by
  from public.issues i
 where i.supplier_id is not null
on conflict do nothing;

commit;
