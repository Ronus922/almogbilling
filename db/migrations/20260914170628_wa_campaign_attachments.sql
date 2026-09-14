-- migrate:up
-- WhatsApp broadcast attachments (14/09/2026). Files attached in the "תפוצה
-- חדשה" tab and sent to every recipient of the campaign after the text.
--
-- Storage: the PRIVATE bucket `whatsapp-attachments`, object key = `<uuid>.<ext>`
-- (the readable name lives ONLY in original_name), served through
-- /api/files/whatsapp-attachments/<key> (session + whatsapp_chat:view).
--
-- Lifecycle: a row is inserted at upload time with campaign_id NULL (staged by
-- uploaded_by) and linked to the campaign at submit. green_api_url is the link
-- Green API `uploadFile` returns — obtained by the worker ONCE per campaign
-- (valid 15 days) and reused for every recipient via `sendFileByUrl`.
-- TODO: staged rows never linked within 24h are not cleaned up yet (no GC job).
create table public.wa_campaign_attachments (
  id                        uuid primary key default gen_random_uuid(),
  campaign_id               uuid references public.wa_campaigns(id) on delete cascade,
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
  green_api_upload_attempts integer not null default 0,
  created_at                timestamptz not null default now()
);

create index wa_campaign_attachments_campaign_idx
  on public.wa_campaign_attachments (campaign_id, sort_order);
create index wa_campaign_attachments_staged_idx
  on public.wa_campaign_attachments (uploaded_by, created_at)
  where campaign_id is null;

comment on table public.wa_campaign_attachments is
  'Files attached to a WhatsApp broadcast (wa_campaigns). campaign_id NULL = uploaded but not yet submitted. green_api_url = Green API uploadFile link (15 days), reused for every recipient via sendFileByUrl.';
comment on column public.wa_campaign_attachments.object_key is
  'Storage key in `bucket` — <uuid>.<ext>, ASCII only. The readable name is original_name.';
comment on column public.wa_campaign_attachments.green_api_upload_attempts is
  'uploadFile attempts by the worker; after 3 failures the worker falls back to sendFileByUpload per recipient.';

-- Per-recipient progress, so a retry resumes AFTER the parts already delivered
-- (text first, then files in sort_order) instead of re-sending them.
-- provider_message_id (existing) marks the text as sent; this counts the files.
alter table public.wa_campaign_recipients
  add column attachments_sent integer not null default 0;

comment on column public.wa_campaign_recipients.attachments_sent is
  'How many campaign attachments (in sort_order) were already sent to this recipient; a retry continues from here.';

-- migrate:down
alter table public.wa_campaign_recipients drop column if exists attachments_sent;
drop table if exists public.wa_campaign_attachments;
