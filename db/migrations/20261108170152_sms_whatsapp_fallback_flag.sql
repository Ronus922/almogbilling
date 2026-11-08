-- migrate:up
-- SMS broadcast: the WhatsApp fallback becomes an explicit, per-campaign
-- opt-in (08/11/2026). Until now every 'sms' campaign fell back to WhatsApp
-- per recipient automatically (16/10/2026, migration 20261016163824); on
-- 08/11/2026 that — combined with the compose form never sending
-- channel='sms' — put ~540 residents' WhatsApp messages out of an account that
-- was meant to send SMS only. The flag is OFF by default, and EVERY existing
-- row is false: a campaign that did not ask for the fallback never gets one.
--
-- Additive only: one NOT NULL column with a constant default (no table
-- rewrite worth the name on a few-hundred-row table), and a CHECK that makes
-- the flag meaningless anywhere but on an 'sms' campaign — so a whatsapp/email
-- campaign can never carry it, whatever the caller sends.

alter table public.wa_campaigns
  add column sms_whatsapp_fallback boolean not null default false,
  add constraint wa_campaigns_sms_whatsapp_fallback_check
    check (not sms_whatsapp_fallback or channel = 'sms');

comment on column public.wa_campaigns.sms_whatsapp_fallback is
  'sms campaigns only: when true, a recipient whose SMS fails (or who has no valid Israeli mobile) is retried over WhatsApp. Default false = the SMS result is final and NOTHING is ever sent over WhatsApp.';

-- migrate:down
alter table public.wa_campaigns
  drop constraint if exists wa_campaigns_sms_whatsapp_fallback_check,
  drop column if exists sms_whatsapp_fallback;
