-- 018_whatsapp_chat_inbox.sql
-- WhatsApp messaging module — Slice 6 (conversational inbox + broadcasts).
--
-- Additive only. Builds ON TOP of the existing chat_messages / whatsapp_templates
-- tables (migration 014) rather than introducing a parallel message store, so the
-- new /messages inbox shows every WhatsApp message in one place: inbound, outbound
-- from the debtors table, and broadcast sends.
--
--   • new table whatsapp_broadcasts — one row per bulk campaign.
--   • chat_messages gains broadcast_id, media_url, read_at.
--   • status CHECK widened with queued/delivered/read (outgoing-status webhook).
--   • two new indexes on chat_messages (chat_id grouping, broadcast_id).
--   • the reserved 'whatsapp_chat' permission module (already in MODULES + role
--     defaults) is backfilled for existing manager/viewer users so the new inbox
--     is reachable for people already in the system.
--
-- Run: docker exec -i supabase-db psql -U postgres -d proj_billing < supabase/migrations/018_whatsapp_chat_inbox.sql

BEGIN;

-- ─────────────────────────────────────────────────────────────────────
-- whatsapp_broadcasts — bulk campaign. audience_filter snapshots the chosen
-- filter ({ type } or { debtor_ids }) at send time. Counters are bumped as the
-- background runner progresses; completed_at is set when it finishes.
-- ─────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.whatsapp_broadcasts (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name            text NOT NULL,
  body            text NOT NULL,
  audience_filter jsonb NOT NULL DEFAULT '{}'::jsonb,
  total_count     integer NOT NULL DEFAULT 0,
  sent_count      integer NOT NULL DEFAULT 0,
  failed_count    integer NOT NULL DEFAULT 0,
  status          text NOT NULL DEFAULT 'pending'
                    CHECK (status IN ('pending', 'running', 'completed', 'failed')),
  created_by      uuid REFERENCES public.users(id) ON DELETE SET NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  completed_at    timestamptz
);

CREATE INDEX IF NOT EXISTS whatsapp_broadcasts_created_at_idx
  ON public.whatsapp_broadcasts (created_at DESC);

-- ─────────────────────────────────────────────────────────────────────
-- chat_messages — extend for the inbox / broadcasts.
--   broadcast_id : links a message to the campaign that sent it (SET NULL keeps
--                  the message if the campaign row is ever removed).
--   media_url    : image/document URL for inbound media (mirrors content).
--   read_at      : when an inbound message was marked read in the inbox; drives
--                  the unread badge (received AND read_at IS NULL = unread).
-- ─────────────────────────────────────────────────────────────────────
ALTER TABLE public.chat_messages
  ADD COLUMN IF NOT EXISTS broadcast_id uuid REFERENCES public.whatsapp_broadcasts(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS media_url    text,
  ADD COLUMN IF NOT EXISTS read_at      timestamptz;

-- Widen the status CHECK to carry the outgoing delivery lifecycle
-- (pending/queued → sent → delivered → read, or failed). The constraint name
-- from 014 is the table-derived default chat_messages_status_check.
ALTER TABLE public.chat_messages DROP CONSTRAINT IF EXISTS chat_messages_status_check;
ALTER TABLE public.chat_messages
  ADD CONSTRAINT chat_messages_status_check
  CHECK (status IN ('pending', 'queued', 'sent', 'delivered', 'read', 'failed'));

CREATE INDEX IF NOT EXISTS chat_messages_chat_id_idx
  ON public.chat_messages (chat_id);
CREATE INDEX IF NOT EXISTS chat_messages_broadcast_idx
  ON public.chat_messages (broadcast_id);

-- ─────────────────────────────────────────────────────────────────────
-- Backfill the reserved 'whatsapp_chat' module permission (the /messages inbox)
-- for existing manager / viewer users, mirroring the role defaults
-- (managers may send, viewers are read-only). super_admin / admin bypass in code
-- and never have rows here.
-- ─────────────────────────────────────────────────────────────────────
INSERT INTO public.user_permissions (user_id, module, can_view, can_edit)
SELECT u.id, 'whatsapp_chat', true, (u.role = 'manager')
  FROM public.users u
 WHERE u.role IN ('manager', 'viewer')
ON CONFLICT (user_id, module) DO NOTHING;

COMMIT;
