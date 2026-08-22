-- 077_seed_parking_1P.down.sql — reverses 077_seed_parking_1P.sql.
--
-- DESTRUCTIVE AND BLUNT: it deletes every spot of lot 1P, not just the 187 the
-- seed inserted. After the seed has been live, the two are not distinguishable
-- — a spot added through the UI and a seeded one look identical, and the seed
-- records no provenance flag (contacts uses source='seed' for this; parking
-- deliberately does not, because a spot's origin is not a property of the spot).
--
-- Any manual edits to the seeded rows are lost with them. The 187 rows can be
-- re-created from ref/parking_spots_1P.csv; anything entered afterwards cannot.
-- Take a dump first.
--
-- Run: psql "$DIRECT_URL" -f supabase/migrations/077_seed_parking_1P.down.sql

begin;

delete from public.parking_spots where lot_code = '1P';

commit;
