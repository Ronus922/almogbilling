-- migrate:up
-- Unified broadcast — an email channel beside WhatsApp (09/10/2026).
--
-- A channel is a property of a broadcast, not a parallel system: the same
-- wa_campaigns / wa_campaign_recipients / wa_campaign_attachments rows, the
-- same worker (wa-queue-worker.service), the same statuses and counters. The
-- worker branches on wa_campaigns.channel; 'whatsapp' behaves exactly as
-- before this migration (every existing row takes the default).
--
-- Additive only — no existing column is changed:
--   • wa_campaigns.channel   'whatsapp' | 'email', NOT NULL, default 'whatsapp'.
--   • wa_campaigns.subject   the email subject as the operator typed it
--     (placeholders and all) — the snapshot beside `body`. Required for an
--     email broadcast, NULL for WhatsApp (CHECK below).
--   • whatsapp_templates.subject   optional; used by the email channel only.
--   • wa_campaign_recipients.email / .subject   the address the message was
--     actually sent to and its subject after placeholder interpolation — the
--     per-recipient snapshot beside `payload`. NULL on a WhatsApp recipient.
--     An email recipient keeps phone_intl = '' and chat_id = '' (both NOT
--     NULL, left untouched) and an idempotency_key of '<campaign>:email:<address>'.
--   • app_settings 'email_rate_per_min' = 30 — the worker's send pace for the
--     email channel (one shared bucket for the SMTP account, like rate_per_min
--     per WhatsApp instance). Existing value kept on a re-run.

alter table public.wa_campaigns
  add column channel text not null default 'whatsapp',
  add column subject text;

alter table public.wa_campaigns
  add constraint wa_campaigns_channel_check check (channel in ('whatsapp', 'email')),
  add constraint wa_campaigns_email_subject_check check (channel <> 'email' or subject is not null);

comment on column public.wa_campaigns.channel is
  'Delivery channel: whatsapp (Green API) or email (SMTP from app_settings). The worker branches on it (09/10/2026).';
comment on column public.wa_campaigns.subject is
  'Email subject as entered (placeholders unresolved). Required when channel = email; NULL for WhatsApp.';

alter table public.whatsapp_templates
  add column subject text;

comment on column public.whatsapp_templates.subject is
  'Optional email subject — fills the subject field when the template is picked for an email broadcast. Ignored by WhatsApp.';

alter table public.wa_campaign_recipients
  add column email text,
  add column subject text;

comment on column public.wa_campaign_recipients.email is
  'Email broadcast: the address this recipient was sent to (snapshot). NULL for a WhatsApp recipient.';
comment on column public.wa_campaign_recipients.subject is
  'Email broadcast: this recipient''s subject after placeholder interpolation (snapshot, like payload). NULL for WhatsApp.';

insert into public.app_settings (key, value)
values ('email_rate_per_min', '30'::jsonb)
on conflict (key) do nothing;

-- migrate:down
delete from public.app_settings where key = 'email_rate_per_min';

alter table public.wa_campaign_recipients
  drop column if exists subject,
  drop column if exists email;

alter table public.whatsapp_templates
  drop column if exists subject;

alter table public.wa_campaigns
  drop constraint if exists wa_campaigns_email_subject_check,
  drop constraint if exists wa_campaigns_channel_check,
  drop column if exists subject,
  drop column if exists channel;
