-- 071_contacts_registry.sql
-- contacts becomes THE apartment registry (single source of truth for
-- apartments + residents). debtors stays a Bllink-fed subset (money only,
-- names/phones become legacy there in a follow-up code change).
--
-- 1. New registry columns on contacts:
--      operator_name / operator_phone  — inline operator person (role #3)
--      unit_type                       — apartment | storage | parking | common | staff | other
--      source                          — where the row came from (residents_import/manual/bllink_sync/seed)
--      needs_review                    — true for rows auto-created from Bllink, not yet
--                                        confirmed by a residents import / manual edit
-- 2. import_runs.kind gains 'residents' (the new row-per-person import).
-- 3. One-time backfill from debtors (additive, COALESCE only — never overwrites
--    a non-empty contacts value):
--      a. debtors apartments missing from contacts -> INSERT (source='seed',
--         needs_review=true). Audit 2026-08-08 expects 0 such rows.
--      b. empty contacts name/phone fields filled from the debtors counterparts
--         (owner_name<-owner_name, owner_phone<-phone_owner,
--          tenant_name<-tenant_name, tenant_phone<-phone_tenant).
--         Rows with debtors.phones_manual_override=true need no special case:
--         the same fill-only-if-empty rule applies (7 such rows at audit time).
--
-- apartment_number is ALREADY unique on contacts (contacts_apartment_number_key)
-- and resident_type ALREADY exists (021) — neither is touched here.
--
-- DOWN: 071_contacts_registry.down.sql (separate file). The COALESCE backfill
-- itself is a data fill and is NOT automatically reversible.
-- Run: psql "$DIRECT_URL" -f supabase/migrations/071_contacts_registry.sql

begin;

-- 1. registry columns ---------------------------------------------------------

alter table public.contacts add column if not exists operator_name  text;
alter table public.contacts add column if not exists operator_phone text;
alter table public.contacts add column if not exists unit_type text not null default 'apartment';
alter table public.contacts add column if not exists source text;
alter table public.contacts add column if not exists needs_review boolean not null default false;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'contacts_unit_type_check') then
    alter table public.contacts add constraint contacts_unit_type_check
      check (unit_type in ('apartment','storage','parking','common','staff','other'));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'contacts_source_check') then
    alter table public.contacts add constraint contacts_source_check
      check (source is null or source in ('residents_import','manual','bllink_sync','seed'));
  end if;
end $$;

-- 2. residents import kind ----------------------------------------------------

alter table public.import_runs drop constraint if exists import_runs_kind_check;
alter table public.import_runs add constraint import_runs_kind_check
  check (kind in ('debtors','contacts','residents'));

-- 3a. seed contacts for debtor apartments that have no contacts row ------------

insert into public.contacts (apartment_number, owner_name, owner_phone, tenant_phone, source, needs_review)
select d.apartment_number,
       nullif(btrim(d.owner_name), ''),
       nullif(btrim(d.phone_owner), ''),
       nullif(btrim(d.phone_tenant), ''),
       'seed',
       true
  from public.debtors d
 where not exists (
         select 1 from public.contacts c
          where c.apartment_number = d.apartment_number
       );

-- 3b. fill EMPTY contacts fields from debtors (never overwrite non-empty) ------

update public.contacts c
   set owner_name   = coalesce(nullif(btrim(c.owner_name),   ''), nullif(btrim(d.owner_name),   '')),
       owner_phone  = coalesce(nullif(btrim(c.owner_phone),  ''), nullif(btrim(d.phone_owner),  '')),
       tenant_name  = coalesce(nullif(btrim(c.tenant_name),  ''), nullif(btrim(d.tenant_name),  '')),
       tenant_phone = coalesce(nullif(btrim(c.tenant_phone), ''), nullif(btrim(d.phone_tenant), ''))
  from public.debtors d
 where d.apartment_number = c.apartment_number
   and (
        ((c.owner_name   is null or btrim(c.owner_name)   = '') and nullif(btrim(d.owner_name),   '') is not null)
     or ((c.owner_phone  is null or btrim(c.owner_phone)  = '') and nullif(btrim(d.phone_owner),  '') is not null)
     or ((c.tenant_name  is null or btrim(c.tenant_name)  = '') and nullif(btrim(d.tenant_name),  '') is not null)
     or ((c.tenant_phone is null or btrim(c.tenant_phone) = '') and nullif(btrim(d.phone_tenant), '') is not null)
   );

commit;
