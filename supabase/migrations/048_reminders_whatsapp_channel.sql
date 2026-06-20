-- 048_reminders_whatsapp_channel.sql
-- Additive: widen the reminders.channel CHECK to allow 'whatsapp' alongside the
-- existing in_app / email / both. The reminders engine (src/lib/reminders/engine.ts)
-- sends a WhatsApp message at the scheduled remind_at when channel='whatsapp'.
--
-- NON-destructive: no DROP TABLE / DROP COLUMN and no data loss. A CHECK
-- constraint cannot be widened in place in Postgres, so the standard additive
-- pattern is to swap the constraint (drop the old CHECK, add the wider one).
-- Existing rows ('in_app' / 'email' / 'both') all still satisfy the new CHECK.
-- Idempotent (drop-if-exists + same constraint name as migration 023's inline,
-- auto-named CHECK).
--
-- Run via DIRECT_URL (session pooler :5432), not the transaction pooler:
--   psql "$DIRECT_URL" -f supabase/migrations/048_reminders_whatsapp_channel.sql

alter table public.reminders
  drop constraint if exists reminders_channel_check;

alter table public.reminders
  add constraint reminders_channel_check
  check (channel in ('in_app', 'email', 'both', 'whatsapp'));
