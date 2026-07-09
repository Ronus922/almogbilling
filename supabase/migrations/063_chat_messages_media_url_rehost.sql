-- 063_chat_messages_media_url_rehost.sql
-- Data fix — no schema change, no DROP.
--
-- Three legacy chat_messages rows (all direction='sent', message_type='image')
-- still hold the storage-host URL that outbound media used before the
-- /api/public/wa-media route existed:
--   https://db.bios.co.il/storage/v1/object/public/whatsapp-media/<key>
-- Rendering them in the inbox, or resending them (resend passes media_url
-- straight to Green API as urlFile), leaks the DB hostname. Rewrite the prefix
-- to the app-origin route; the <key> is unchanged and each key opens with a
-- UUID, so all three are servable by that route as-is.
--
-- Idempotent: the WHERE clause matches only the old prefix, so a re-run is a
-- no-op. Rollback: swap the two strings in the REPLACE and re-run.
--
-- Run: psql "$DIRECT_URL" -f supabase/migrations/063_chat_messages_media_url_rehost.sql

BEGIN;

UPDATE public.chat_messages
   SET media_url = REPLACE(
         media_url,
         'https://db.bios.co.il/storage/v1/object/public/whatsapp-media/',
         'https://billing.bios.co.il/api/public/wa-media/')
 WHERE media_url LIKE 'https://db.bios.co.il/storage/v1/object/public/whatsapp-media/%';

COMMIT;
