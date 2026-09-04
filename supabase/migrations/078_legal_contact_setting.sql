-- 078_legal_contact_setting.sql
-- Settings → "עורך דין": the lawyer's contact lives in app_settings under
-- key 'legal_contact' as { email, name } — never in code. The legal-status
-- change notification reads it at send time (see
-- src/app/api/debtors/[id]/legal-status/route.ts).
--
-- Seeds the row EMPTY so the value is discoverable in the table; the app also
-- tolerates a missing row (reads as empty = not configured, nothing is sent).
-- Additive only: no schema change, and `on conflict do nothing` never
-- overwrites a value that was already saved through the Settings screen.
--
-- DOWN: 078_legal_contact_setting.down.sql (separate file).
-- Run: psql "$DIRECT_URL" -f supabase/migrations/078_legal_contact_setting.sql

begin;

insert into public.app_settings (key, value)
values ('legal_contact', '{"email": "", "name": ""}'::jsonb)
on conflict (key) do nothing;

commit;
