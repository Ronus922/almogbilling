-- migrate:up
-- Purchasing, second alignment (22/10/2026) — Ronen's two decisions, purchasing_*
-- tables only (nothing else is touched):
--   1. DRAFTS ON THE SERVER: purchasing_documents.status ('draft' | 'issued').
--      A draft takes no number (number becomes nullable); the running number is
--      allocated only when it is issued (the existing atomic allocation). A draft
--      is exempt from the "request has a due date" / "has a supplier" rules.
--   2. A HAND-TYPED SUPPLIER GETS THE SAME TREATMENT as a listed one: the
--      recipient (personal link), the quote and the dispatch log rows may have
--      supplier_id NULL and carry the supplier's details themselves. A hand-typed
--      supplier is never added to public.suppliers. At most one hand-typed
--      recipient / quote per request (a document has one typed supplier).

-- ── 1. drafts ───────────────────────────────────────────────────────────────
alter table public.purchasing_documents
  add column status text not null default 'issued' check (status in ('draft', 'issued'));
alter table public.purchasing_documents alter column number drop not null;
alter table public.purchasing_documents
  add constraint purchasing_documents_issued_has_number check (status = 'draft' or number is not null);

alter table public.purchasing_documents drop constraint purchasing_documents_rfq_has_due;
alter table public.purchasing_documents
  add constraint purchasing_documents_rfq_has_due check (status = 'draft' or doc_type <> 'rfq' or due_date is not null);

alter table public.purchasing_documents drop constraint purchasing_documents_has_supplier;
alter table public.purchasing_documents
  add constraint purchasing_documents_has_supplier check (
    status = 'draft' or supplier_id is not null or nullif(btrim(coalesce(supplier_name, '')), '') is not null
  ) not valid;

comment on column public.purchasing_documents.status is
  'draft = saved from the form without a number (editable from any device, never sent, no PDF); issued = has its running number.';

-- ── 2. hand-typed supplier on the recipient / quote / dispatch rows ─────────
alter table public.purchasing_rfq_recipients
  alter column supplier_id drop not null,
  add column supplier_name    text,
  add column supplier_phone   text,
  add column supplier_email   text,
  add column supplier_address text;
alter table public.purchasing_rfq_recipients
  add constraint purchasing_rfq_recipients_has_supplier check (
    supplier_id is not null or nullif(btrim(coalesce(supplier_name, '')), '') is not null
  );
create unique index purchasing_rfq_recipients_manual_uidx
  on public.purchasing_rfq_recipients (rfq_id) where supplier_id is null;

alter table public.purchasing_quotes
  alter column supplier_id drop not null,
  add column supplier_name    text,
  add column supplier_phone   text,
  add column supplier_email   text,
  add column supplier_address text;
alter table public.purchasing_quotes
  add constraint purchasing_quotes_has_supplier check (
    supplier_id is not null or nullif(btrim(coalesce(supplier_name, '')), '') is not null
  );
create unique index purchasing_quotes_manual_uidx
  on public.purchasing_quotes (rfq_id) where supplier_id is null;

alter table public.purchasing_dispatches
  alter column supplier_id drop not null,
  add column supplier_name text;
alter table public.purchasing_dispatches
  add constraint purchasing_dispatches_has_supplier check (
    supplier_id is not null or nullif(btrim(coalesce(supplier_name, '')), '') is not null
  );

-- migrate:down
-- Rows that only exist because of this migration cannot survive it: drafts (no
-- number) and the hand-typed recipient / quote / dispatch rows (no supplier_id).
delete from public.purchasing_documents where status = 'draft';
delete from public.purchasing_dispatches where supplier_id is null;
delete from public.purchasing_quotes where supplier_id is null;
delete from public.purchasing_rfq_recipients where supplier_id is null;
update public.purchasing_documents
   set winner_chosen_by = null, winner_chosen_at = null
 where winner_supplier_id is null and winner_chosen_at is not null;

alter table public.purchasing_dispatches drop constraint purchasing_dispatches_has_supplier;
alter table public.purchasing_dispatches drop column supplier_name, alter column supplier_id set not null;

drop index public.purchasing_quotes_manual_uidx;
alter table public.purchasing_quotes drop constraint purchasing_quotes_has_supplier;
alter table public.purchasing_quotes
  drop column supplier_address, drop column supplier_email, drop column supplier_phone, drop column supplier_name,
  alter column supplier_id set not null;

drop index public.purchasing_rfq_recipients_manual_uidx;
alter table public.purchasing_rfq_recipients drop constraint purchasing_rfq_recipients_has_supplier;
alter table public.purchasing_rfq_recipients
  drop column supplier_address, drop column supplier_email, drop column supplier_phone, drop column supplier_name,
  alter column supplier_id set not null;

alter table public.purchasing_documents drop constraint purchasing_documents_has_supplier;
alter table public.purchasing_documents
  add constraint purchasing_documents_has_supplier check (
    supplier_id is not null or nullif(btrim(coalesce(supplier_name, '')), '') is not null
  ) not valid;
alter table public.purchasing_documents drop constraint purchasing_documents_rfq_has_due;
alter table public.purchasing_documents
  add constraint purchasing_documents_rfq_has_due check (doc_type <> 'rfq' or due_date is not null);
alter table public.purchasing_documents drop constraint purchasing_documents_issued_has_number;
alter table public.purchasing_documents alter column number set not null;
alter table public.purchasing_documents drop column status;
