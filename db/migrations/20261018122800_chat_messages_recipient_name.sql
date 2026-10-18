-- migrate:up
alter table public.chat_messages add column recipient_name text;

comment on column public.chat_messages.recipient_name is
  'Label of who an OUTBOUND message was addressed to, snapshotted at send time '
  '(e.g. "בעלים" / "שוכר/ת" / "בעלים נוסף · <name>") -- lets one debtor''s '
  'history show which of several phones a given message went to, for the '
  'multi-recipient single-send feature (18/10/2026). Null for inbound rows and '
  'for outbound rows sent before this column existed. Mirrors '
  'wa_campaign_recipients.recipient_name.';

-- migrate:down
alter table public.chat_messages drop column recipient_name;
