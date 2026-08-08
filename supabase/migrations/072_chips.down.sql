-- 072_chips.down.sql — reverses 072_chips.sql.
-- Drops chip_events before chips (FK), then removes the permission seed.
-- Run: psql "$DIRECT_URL" -f supabase/migrations/072_chips.down.sql

begin;

drop table if exists public.chip_events;
drop table if exists public.chips;
delete from public.user_permissions where module = 'chips';

commit;
