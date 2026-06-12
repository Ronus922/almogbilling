-- 020_whatsapp_instances.sql
-- WhatsApp multi-instance — one Green API instance per employee (like Wati /
-- respond.io, where every agent connects their own number).
--
-- Additive only:
--   • new table whatsapp_instances — one row per employee (user_id UNIQUE), with
--     the AES-256-GCM-encrypted Green API token (SAME { iv, ct, tag } blob shape
--     the app_settings green_api / smtp keys already use).
--   • chat_messages + whatsapp_broadcasts gain a nullable instance_id FK so every
--     message / campaign is attributed to the sending instance.
--   • DATA MIGRATION: if a global Green API credential exists in app_settings
--     (key='green_api'), it is promoted to the FIRST instance, owned by the first
--     super_admin, and every existing message / broadcast is back-filled to it.
--     The app stops reading the global credential after this migration.
--
-- Run: docker exec -i supabase-db psql -U postgres -d proj_billing < supabase/migrations/020_whatsapp_instances.sql

BEGIN;

-- ─────────────────────────────────────────────────────────────────────
-- whatsapp_instances — per-employee Green API connection.
--   user_id           UNIQUE → exactly one instance per employee.
--   green_instance_id  Green API idInstance (e.g. "7107545950"); UNIQUE so the
--                      inbound webhook can resolve instanceData.idInstance → row.
--   green_token_enc    AES-256-GCM { iv, ct, tag } (base64) — same cipher as SMTP.
--   api_url            Green API host (per-instance; Green assigns regional hosts).
--   state              cached connection state from getStateInstance / stateWebhook.
-- ─────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.whatsapp_instances (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id           uuid NOT NULL UNIQUE REFERENCES public.users(id) ON DELETE CASCADE,
  display_name      text NOT NULL,
  green_instance_id text NOT NULL,
  green_token_enc   jsonb NOT NULL,
  api_url           text NOT NULL DEFAULT 'https://api.green-api.com',
  state             text NOT NULL DEFAULT 'notAuthorized'
                      CHECK (state IN ('notAuthorized','authorized','blocked','starting','yellowCard','sleepMode')),
  state_checked_at  timestamptz,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);

-- One Green API instance maps to exactly one row (webhook lookup key).
CREATE UNIQUE INDEX IF NOT EXISTS whatsapp_instances_green_id_idx
  ON public.whatsapp_instances (green_instance_id);

DROP TRIGGER IF EXISTS whatsapp_instances_touch_updated_at ON public.whatsapp_instances;
CREATE TRIGGER whatsapp_instances_touch_updated_at
  BEFORE UPDATE ON public.whatsapp_instances
  FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();

-- ─────────────────────────────────────────────────────────────────────
-- Attribute every message / campaign to its sending instance (nullable so old
-- rows and any future global path stay valid; SET NULL keeps history if an
-- instance is removed).
-- ─────────────────────────────────────────────────────────────────────
ALTER TABLE public.chat_messages
  ADD COLUMN IF NOT EXISTS instance_id uuid REFERENCES public.whatsapp_instances(id) ON DELETE SET NULL;
ALTER TABLE public.whatsapp_broadcasts
  ADD COLUMN IF NOT EXISTS instance_id uuid REFERENCES public.whatsapp_instances(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS chat_messages_instance_idx
  ON public.chat_messages (instance_id, chat_id);

-- ─────────────────────────────────────────────────────────────────────
-- DATA MIGRATION — promote the existing global credential to instance #1.
-- The token blob (value->'tokenEnc') is copied verbatim: identical cipher, no
-- re-encryption needed. Assigned to the first super_admin. State seeded as
-- 'authorized' because the global credential was a live, sending instance.
-- Idempotent: ON CONFLICT (user_id) DO NOTHING + guarded by NOT EXISTS.
-- ─────────────────────────────────────────────────────────────────────
INSERT INTO public.whatsapp_instances
  (user_id, display_name, green_instance_id, green_token_enc, api_url, state, state_checked_at)
SELECT
  (SELECT id FROM public.users WHERE role = 'super_admin' ORDER BY created_at ASC LIMIT 1),
  'WhatsApp ראשי',
  s.value->>'instanceId',
  s.value->'tokenEnc',
  'https://api.green-api.com',
  'authorized',
  now()
FROM public.app_settings s
WHERE s.key = 'green_api'
  AND s.value ? 'instanceId'
  AND s.value ? 'tokenEnc'
  AND EXISTS (SELECT 1 FROM public.users WHERE role = 'super_admin')
  AND NOT EXISTS (SELECT 1 FROM public.whatsapp_instances)
ON CONFLICT (user_id) DO NOTHING;

-- Back-fill existing messages + broadcasts onto that first instance.
UPDATE public.chat_messages
   SET instance_id = (SELECT id FROM public.whatsapp_instances ORDER BY created_at ASC LIMIT 1)
 WHERE instance_id IS NULL
   AND EXISTS (SELECT 1 FROM public.whatsapp_instances);

UPDATE public.whatsapp_broadcasts
   SET instance_id = (SELECT id FROM public.whatsapp_instances ORDER BY created_at ASC LIMIT 1)
 WHERE instance_id IS NULL
   AND EXISTS (SELECT 1 FROM public.whatsapp_instances);

COMMIT;
