-- 074_chips_holder_identity_search.down.sql — reverses 074.
-- pg_trgm itself is left installed on purpose: dropping an extension is a
-- database-level decision and other objects may have adopted it meanwhile.
-- Run: psql "$DIRECT_URL" -f supabase/migrations/074_chips_holder_identity_search.down.sql

begin;

drop index if exists public.contacts_operator_name_trgm_idx;
drop index if exists public.contacts_tenant_name_trgm_idx;
drop index if exists public.contacts_owner_name_trgm_idx;
drop index if exists public.chips_holder_name_trgm_idx;
drop index if exists public.chips_apartment_trgm_idx;
drop index if exists public.chips_number_trgm_idx;

drop index if exists public.chips_holder_idx;

alter table public.chips drop constraint if exists chips_holder_identity_check;
alter table public.chips alter column resident_role drop not null;

commit;
