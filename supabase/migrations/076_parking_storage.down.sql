-- 076_parking_storage.down.sql — reverses 076_parking_storage.sql.
--
-- Neither table is referenced by anything else (no FK points AT them), so the
-- drop order between them does not matter; both are dropped before the
-- permission rows are removed, purely for readability.
--
-- Indexes and triggers go with their tables (DROP TABLE takes them along), so
-- they are not listed individually.
--
-- DESTRUCTIVE: this drops the seeded 187 parking spots of lot 1P and every
-- storage unit entered through the UI. There is no other copy of the storage
-- data — the parking seed can be re-imported from ref/parking_spots_1P.csv,
-- storage cannot. Take a dump first if the data matters.
-- Run: psql "$DIRECT_URL" -f supabase/migrations/076_parking_storage.down.sql

begin;

drop table if exists public.storage_units;
drop table if exists public.parking_spots;

delete from public.user_permissions where module = 'parking';

commit;
