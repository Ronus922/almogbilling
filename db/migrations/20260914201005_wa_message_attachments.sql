-- migrate:up
-- Attachments of a SINGLE outbound WhatsApp message (the "שליחת הודעת WhatsApp"
-- sheet of the debtor card / debtors table) — up to 5 per message, the same
-- type/size policy as a broadcast (src/lib/constants/whatsappAttachments.ts).
--
-- Storage: the PRIVATE bucket `whatsapp-attachments` — the same one broadcasts
-- use — with the object key `<uuid>.<ext>`; the readable (Hebrew) name lives
-- only in original_name, and the browser reaches a file only through
-- /api/files/whatsapp-attachments/<key> (session + permission). New messages no
-- longer write to the PUBLIC whatsapp-media bucket.
-- TODO: files already in whatsapp-media (messages sent before this change) stay
-- where they are and keep rendering from chat_messages.media_url; no migration
-- of those objects is attempted here.
--
-- Lifecycle: a row is inserted at upload time with message_id NULL (staged by
-- uploaded_by) and linked to the chat_messages row when the message is sent.
-- green_api_url is the link Green API `uploadFile` returns (valid 15 days); it
-- is what sendFileByUrl is given, so the private bytes never need a public URL.
-- A resend past the 15 days re-uploads from the bucket and refreshes it.
-- TODO: staged rows never linked within 24h are not cleaned up yet (no GC job).
--
-- This table is the SOURCE OF TRUTH for a message's files. chat_messages keeps
-- its legacy single-file columns (media_url / attachment_name / attachment_mime
-- / attachment_size) populated from the FIRST file so the existing history
-- renderers and the resend route keep working unchanged, and message_type stays
-- inside its existing CHECK ('text' | 'image' | 'document') — a video/audio
-- attachment is recorded as 'document' on the parent row.
create table public.wa_message_attachments (
  id                        uuid primary key default gen_random_uuid(),
  message_id                uuid references public.chat_messages(id) on delete cascade,
  uploaded_by               uuid,
  bucket                    text not null,
  object_key                text not null unique,
  original_name             text not null,
  mime_type                 text not null,
  size_bytes                bigint not null check (size_bytes > 0),
  sort_order                integer not null default 0,
  green_api_url             text,
  green_api_url_expires_at  timestamptz,
  green_api_error           text,
  created_at                timestamptz not null default now()
);

create index wa_message_attachments_message_idx
  on public.wa_message_attachments (message_id, sort_order);
create index wa_message_attachments_staged_idx
  on public.wa_message_attachments (uploaded_by, created_at)
  where message_id is null;

comment on table public.wa_message_attachments is
  'Files attached to ONE outbound WhatsApp message (chat_messages). message_id NULL = uploaded but not yet sent. The source of truth for a message files; chat_messages keeps the first file in its legacy columns. green_api_url = Green API uploadFile link (15 days) handed to sendFileByUrl.';
comment on column public.wa_message_attachments.object_key is
  'Storage key in `bucket` (whatsapp-attachments, private) — <uuid>.<ext>, ASCII only. The readable name is original_name.';
comment on column public.wa_message_attachments.sort_order is
  'Send order within the message: the text (or the caption of a single file) goes first, then the files by this column.';

-- migrate:down
drop table if exists public.wa_message_attachments;
