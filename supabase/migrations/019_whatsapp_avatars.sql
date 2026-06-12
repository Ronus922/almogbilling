-- 019_whatsapp_avatars.sql
-- WhatsApp profile pictures for the /messages inbox.
--
-- Additive only: one new table. Green API's getAvatar returns a WhatsApp CDN
-- link (urlAvatar) that EXPIRES, so the URL must be cached and refreshed
-- periodically — never fetched on every conversation-list load. This table is
-- that cache:
--   • chat_id    — the conversation key ("972…@c.us" / "…@g.us"), PK.
--   • avatar_url — the last fetched URL, or NULL when the contact has no picture
--                  (a NULL row with a fresh fetched_at means "checked, none" so
--                  we don't re-probe Green API for days).
--   • fetched_at — drives the lazy 3-day refresh window.
--
-- Run: docker exec -i supabase-db psql -U postgres -d proj_billing < supabase/migrations/019_whatsapp_avatars.sql

BEGIN;

CREATE TABLE IF NOT EXISTS public.whatsapp_avatars (
  chat_id    text PRIMARY KEY,
  avatar_url text,
  fetched_at timestamptz NOT NULL DEFAULT now()
);

COMMIT;
