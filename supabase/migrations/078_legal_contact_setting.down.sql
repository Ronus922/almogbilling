-- 078_legal_contact_setting.down.sql — reverses 078.
-- Removes the legal_contact row, INCLUDING a value saved through the Settings
-- screen — note it down first if it matters. The app keeps working without
-- the row (reads as "not configured").
-- Run: psql "$DIRECT_URL" -f supabase/migrations/078_legal_contact_setting.down.sql

begin;

delete from public.app_settings where key = 'legal_contact';

commit;
