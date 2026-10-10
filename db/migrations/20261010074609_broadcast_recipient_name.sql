-- migrate:up
-- The delivery log names the person a broadcast message actually went to
-- (10/10/2026).
--
-- Until now the log's "נמען" column was derived at read time from the
-- apartment card — coalesce(contacts.owner_name, contacts.tenant_name,
-- suppliers.display_name) — so a message sent to a tenant or to an additional
-- owner (contact_people) was listed under the apartment's primary owner.
--
-- Additive only: wa_campaign_recipients.recipient_name, snapshotted when the
-- broadcast is created, for both channels:
--   • primary owner / tenant → contacts.owner_name / tenant_name
--   • additional owner / tenant → contact_people.name
--   • supplier → suppliers.display_name
--   • a debt message consolidated across apartments → every distinct name the
--     address carries, joined with " / "
--   • ''  — the card holds no name for that person (shown as "—", never as
--     somebody else's name)
--   • NULL — only on rows created before this migration; the log falls back
--     to the apartment's primary owner, exactly as it did before.

alter table public.wa_campaign_recipients
  add column recipient_name text;

comment on column public.wa_campaign_recipients.recipient_name is
  'Name of the person this message was addressed to, snapshotted at creation (owner / tenant / additional person / supplier). '''' = the card has no name for them; NULL = created before 10/10/2026 (the log falls back to the apartment''s primary owner).';

-- migrate:down
alter table public.wa_campaign_recipients
  drop column recipient_name;
