-- Document the meaning of whatsapp_instances.user_id at the schema level.
-- No structural change: comment only, safe to re-run, nothing to roll back.
--
-- The connected WhatsApp instance is SHARED between all authorized users.
-- Access is decided by the whatsapp_chat permission alone, never by this column.

COMMENT ON COLUMN public.whatsapp_instances.user_id IS
  'Nominal technical owner: webhook routing + legacy instance association ONLY. '
  'NOT an authorization boundary — never use it to decide who may view chats, '
  'send messages, pull messages, or run campaigns. Access is controlled '
  'exclusively by the whatsapp_chat permission; the instance is shared between '
  'all authorized users. Tech debt: rename to webhook_owner_user_id.';
