-- 058_chat_presence.sql
-- Feature A (internal-chat presence): a per-user "last activity" stamp so the
-- chat can show an online indicator ("● מחוברת עכשיו"). Online is DERIVED at read
-- time as (now() - last_seen_at < 60s) — no stored boolean that could go stale.
-- The stamp is refreshed by the chat SSE stream (on connect + every heartbeat).
--
-- ADDITIVE ONLY. One nullable column on public.users. Idempotent (IF NOT EXISTS)
-- — safe to re-run. No existing data is touched or deleted.
--
-- Run: psql "$DIRECT_URL" -f supabase/migrations/058_chat_presence.sql

alter table public.users
  add column if not exists last_seen_at timestamptz;

comment on column public.users.last_seen_at is
  'Last realtime-chat heartbeat (SSE connect/heartbeat). Drives the online dot: online = now() - last_seen_at < 60s.';
