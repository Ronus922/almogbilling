-- 071_contacts_registry.down.sql — reverses 071_contacts_registry.sql.
-- Run 072_chips.down.sql FIRST if 072 was applied (chips FK-references contacts
-- with ON DELETE RESTRICT, which would block deleting seed contacts).
--
-- NOTE: step 3b of 071 (COALESCE fill of empty contacts fields from debtors)
-- is a data fill with no recorded provenance — it is NOT reversed here. Only
-- rows/columns 071 created are removed.
-- Run: psql "$DIRECT_URL" -f supabase/migrations/071_contacts_registry.down.sql

begin;

-- residents import kind: remove rows first, then tighten the CHECK back
delete from public.import_runs where kind = 'residents';
alter table public.import_runs drop constraint if exists import_runs_kind_check;
alter table public.import_runs add constraint import_runs_kind_check
  check (kind in ('debtors','contacts'));

-- seed-created contacts (identifiable by source='seed')
delete from public.contacts where source = 'seed';

alter table public.contacts drop constraint if exists contacts_source_check;
alter table public.contacts drop constraint if exists contacts_unit_type_check;
alter table public.contacts drop column if exists needs_review;
alter table public.contacts drop column if exists source;
alter table public.contacts drop column if exists unit_type;
alter table public.contacts drop column if exists operator_phone;
alter table public.contacts drop column if exists operator_name;

commit;
