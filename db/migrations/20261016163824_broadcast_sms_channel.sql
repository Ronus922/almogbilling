-- migrate:up
-- Unified broadcast — SMS joins WhatsApp and email as a third channel
-- (16/10/2026, 019sms — docs/sms-provider.md). Same campaign/recipient rows,
-- same worker, same statuses and counters; the worker branches on
-- wa_campaigns.channel exactly as it already does for email.
--
-- Per-recipient fallback (SMS send failed, or the recipient has no valid
-- Israeli mobile): the worker automatically retries over WhatsApp instead of
-- failing the recipient. wa_campaign_recipients.sent_channel records which
-- channel actually carried the message — it can differ from
-- wa_campaigns.channel ONLY for an 'sms' campaign that fell back; it is
-- NULL until a send succeeds, and always equals the campaign's channel for
-- whatsapp/email (no fallback exists there).
--
-- No attachments on the SMS channel (019 is text-only) — enforced by the
-- compose UI, not by a DB constraint (same as the existing per-channel
-- attachment limits, which are also UI-side).
--
-- app_settings 'sms_rate_per_min' = 20 — OUR OWN conservative default, not a
-- documented 019 limit (their docs publish no per-minute throttle, only a
-- 2500-recipient cap per bulk API call). Adjustable later like
-- email_rate_per_min; existing value kept on a re-run.

alter table public.wa_campaigns
  drop constraint wa_campaigns_channel_check,
  add constraint wa_campaigns_channel_check check (channel in ('whatsapp', 'email', 'sms'));

alter table public.wa_campaign_recipients
  add column sent_channel text,
  add constraint wa_campaign_recipients_sent_channel_check
    check (sent_channel is null or sent_channel in ('whatsapp', 'email', 'sms'));

comment on column public.wa_campaign_recipients.sent_channel is
  'Channel that actually carried this message. NULL until sent. Equals the campaign''s channel, EXCEPT an sms campaign that fell back to whatsapp per-recipient (send failure or no valid Israeli mobile) — then ''whatsapp''.';

insert into public.app_settings (key, value)
values ('sms_rate_per_min', '20'::jsonb)
on conflict (key) do nothing;

-- migrate:down
delete from public.app_settings where key = 'sms_rate_per_min';

alter table public.wa_campaign_recipients
  drop constraint if exists wa_campaign_recipients_sent_channel_check,
  drop column if exists sent_channel;

alter table public.wa_campaigns
  drop constraint wa_campaigns_channel_check,
  add constraint wa_campaigns_channel_check check (channel in ('whatsapp', 'email'));
