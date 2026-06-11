-- 014_whatsapp.sql
-- WhatsApp module — outbound sending only (phase 1).
-- Additive only: two new tables, one debtors column, one app_settings key
-- (Green API credentials), and a permission backfill for the new 'whatsapp'
-- module. Nothing is dropped or rewritten.
--
-- Green API credentials reuse the existing app_settings jsonb key/value store
-- (the same store SMTP uses with key='smtp'), NOT new columns: app_settings is
-- a generic KV table, so columns like green_api_instance_id would be null for
-- every other key. The token is AES-256-GCM-encrypted with the SAME helper the
-- Gmail SMTP App Password uses (src/lib/crypto/settings-cipher.ts).
--
-- Run: docker exec -i supabase-db psql -U postgres -d proj_billing < supabase/migrations/014_whatsapp.sql

BEGIN;

-- ─────────────────────────────────────────────────────────────────────
-- whatsapp_templates — reusable message bodies with {{placeholders}}.
-- Soft-deleted via is_active=false (never hard-deleted).
-- ─────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.whatsapp_templates (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name        text NOT NULL,
  content     text NOT NULL,
  is_active   boolean NOT NULL DEFAULT true,
  created_by  uuid REFERENCES public.users(id) ON DELETE SET NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS whatsapp_templates_active_idx
  ON public.whatsapp_templates (is_active);

DROP TRIGGER IF EXISTS whatsapp_templates_touch_updated_at ON public.whatsapp_templates;
CREATE TRIGGER whatsapp_templates_touch_updated_at
  BEFORE UPDATE ON public.whatsapp_templates
  FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();

-- ─────────────────────────────────────────────────────────────────────
-- chat_messages — one row per WhatsApp message. Phase 1 writes only
-- outbound rows (direction='sent'); the schema already accommodates the
-- future inbound/linking flow (link_status, message_type, received).
-- external_message_id is the Green API idMessage; UNIQUE but nullable so
-- failed sends (no id) coexist (Postgres allows many NULLs in a UNIQUE col).
-- debtor_id is nullable + ON DELETE SET NULL so the message log survives a
-- debtor deletion (history of communication is kept).
-- ─────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.chat_messages (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  debtor_id           uuid REFERENCES public.debtors(id) ON DELETE SET NULL,
  contact_phone       text NOT NULL,
  chat_id             text,                          -- 972...@c.us
  external_message_id text UNIQUE,                   -- Green API idMessage
  link_status         text NOT NULL DEFAULT 'linked'
                        CHECK (link_status IN ('linked', 'unlinked')),
  direction           text NOT NULL
                        CHECK (direction IN ('sent', 'received')),
  message_type        text NOT NULL DEFAULT 'text'
                        CHECK (message_type IN ('text', 'image', 'document')),
  content             text,
  status              text NOT NULL DEFAULT 'pending'
                        CHECK (status IN ('pending', 'sent', 'failed')),
  error_detail        text,
  sent_by             uuid REFERENCES public.users(id) ON DELETE SET NULL,
  created_at          timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS chat_messages_debtor_idx
  ON public.chat_messages (debtor_id, created_at DESC);
CREATE INDEX IF NOT EXISTS chat_messages_external_id_idx
  ON public.chat_messages (external_message_id);

-- ─────────────────────────────────────────────────────────────────────
-- debtors.last_whatsapp_sent_at — updated only on a successful send.
-- ─────────────────────────────────────────────────────────────────────
ALTER TABLE public.debtors
  ADD COLUMN IF NOT EXISTS last_whatsapp_sent_at timestamptz;

-- ─────────────────────────────────────────────────────────────────────
-- Green API credentials live in app_settings under key='green_api'.
-- Value shape: { instanceId: text, tokenEnc: { iv, ct, tag } } (base64).
-- ─────────────────────────────────────────────────────────────────────
COMMENT ON COLUMN public.app_settings.value IS
  'Schema is per-key. key=smtp: { user, fromName, passEnc:{ iv, ct, tag } }. '
  'key=green_api: { instanceId, tokenEnc:{ iv, ct, tag } }. Enc fields are base64 (AES-256-GCM).';

-- ─────────────────────────────────────────────────────────────────────
-- Backfill the new 'whatsapp' module permission for existing manager /
-- viewer users so the new module's defaults apply to people already in the
-- system (matrix defaults: managers may send, viewers are read-only).
-- super_admin / admin are hardcoded in code and never have rows here.
-- ─────────────────────────────────────────────────────────────────────
INSERT INTO public.user_permissions (user_id, module, can_view, can_edit)
SELECT u.id, 'whatsapp', true, (u.role = 'manager')
  FROM public.users u
 WHERE u.role IN ('manager', 'viewer')
ON CONFLICT (user_id, module) DO NOTHING;

COMMIT;
