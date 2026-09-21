-- migrate:up

-- One row per (recipient, apartment) — replaces the assumption that a
-- wa_campaign_recipients row is exactly one apartment. A recipient row is now
-- one phone number for a campaign (unchanged), but a phone can cover several
-- apartments (multi-apartment owner/tenant, or an operator managing many
-- units — e.g. "אלמוג ביץ" on 40+ units). contact_id RESTRICT here is what
-- protects an apartment's contact from deletion once it has broadcast
-- history — the same job wa_campaign_recipients.contact_id's FK did before
-- this migration, just at per-apartment granularity now that one recipient
-- can span several apartments.
create table public.wa_campaign_recipient_apartments (
  id uuid primary key default gen_random_uuid(),
  recipient_id uuid not null references public.wa_campaign_recipients(id) on delete cascade,
  contact_id uuid not null references public.contacts(id) on delete restrict,
  debtor_id uuid,
  created_at timestamptz not null default now(),
  unique (recipient_id, contact_id)
);

create index wa_campaign_recipient_apartments_recipient_id_idx
  on public.wa_campaign_recipient_apartments (recipient_id);
create index wa_campaign_recipient_apartments_contact_id_idx
  on public.wa_campaign_recipient_apartments (contact_id);

-- Backfill BEFORE relaxing contact_id below, while it's still guaranteed
-- NOT NULL on every existing row — one link row per historical recipient,
-- carrying over the exact same contact_id/debtor_id it already had. This is
-- what keeps PR1's delete-protection identical by construction: the set of
-- contact_id values referenced here is exactly the set wa_campaign_recipients
-- .contact_id referenced before, not a superset or subset.
insert into public.wa_campaign_recipient_apartments (recipient_id, contact_id, debtor_id)
select id, contact_id, debtor_id
from public.wa_campaign_recipients;

-- A recipient is now EITHER apartment-based (contact_id set, 1+ rows in the
-- link table above) OR a supplier (supplier_id set, zero link-table rows —
-- a supplier is a recipient with no apartment). contact_id stays a
-- REPRESENTATIVE reference on the parent row for display convenience
-- (existing UI joins it directly); the link table is the source of truth for
-- which apartments a multi-apartment recipient actually covers.
alter table public.wa_campaign_recipients
  alter column contact_id drop not null;

alter table public.wa_campaign_recipients
  add column supplier_id uuid references public.suppliers(id) on delete restrict;

alter table public.wa_campaign_recipients
  add constraint wa_campaign_recipients_contact_or_supplier_check
  check (contact_id is not null or supplier_id is not null);

-- migrate:down

alter table public.wa_campaign_recipients
  drop constraint wa_campaign_recipients_contact_or_supplier_check;

alter table public.wa_campaign_recipients
  drop column supplier_id;

alter table public.wa_campaign_recipients
  alter column contact_id set not null;

drop table public.wa_campaign_recipient_apartments;
