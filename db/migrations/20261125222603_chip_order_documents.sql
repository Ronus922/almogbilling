-- migrate:up
-- Chip orders: invoices / receipts / credit documents issued by OUR code through
-- the Morning (Green Invoice) API of the building's account (26/11/2026, night
-- run — docs/chip-orders.md "מסמכי מורנינג").
--
-- Additive only: one new table. No existing column, constraint or row changes.
--
-- chip_order_documents — the queue AND the record. One row per money movement
-- that needs a document, written in the SAME transaction as the movement:
--   kind 'invoice' — a payment was received (a card charge PayPlus confirmed, or
--                    cash / a bank transfer recorded at the reception);
--   kind 'credit'  — money went back (a refund, a cancelled reception order).
-- payment_key is UNIQUE: one document per payment (or refund), ever — the same
-- charge reported twice, or a retry, can never make a second row. The issuer
-- claims due rows (FOR UPDATE SKIP LOCKED), calls Morning, and stores what
-- Morning answered. A row claimed and never finished (a crash) is searched for
-- in Morning before it is issued again (its `ref` is printed on the document).
--
-- A TEST order never gets a row (the code refuses it; nothing here can tell a
-- test order from the row itself, so the rule lives in src/lib/db/chipOrderDocuments.ts).
-- Rows are never deleted by the code; ON DELETE RESTRICT keeps an order that has
-- a document from being deleted at all.

create table public.chip_order_documents (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null references public.chip_orders(id) on delete restrict,
  kind text not null,
  payment_key text not null,
  -- A short unique reference printed on the document (crash recovery).
  ref text not null,
  amount numeric(10,2) not null,
  payment_method text not null,
  status text not null default 'pending',
  attempts integer not null default 0,
  next_attempt_at timestamptz not null default now(),
  claimed_at timestamptz,
  last_error text,
  -- The invoice row this credit row cancels (kind 'credit' only).
  credit_of uuid references public.chip_order_documents(id) on delete restrict,
  -- What the document records about the payment: last 4 digits, approval
  -- number, the payment date, the refund's processor id. Never card data.
  details jsonb not null default '{}'::jsonb,
  -- What Morning answered: every document issued for this row, in order
  -- ([{type, id, number, url}] — a credit of a tax invoice-receipt is two
  -- documents: a credit invoice and a negative receipt).
  morning_docs jsonb not null default '[]'::jsonb,
  issued_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint chip_order_documents_payment_key_key unique (payment_key),
  constraint chip_order_documents_ref_key unique (ref),
  constraint chip_order_documents_kind_check check (kind in ('invoice', 'credit')),
  constraint chip_order_documents_status_check check (status in ('pending', 'issuing', 'issued', 'failed')),
  constraint chip_order_documents_method_check check (payment_method in ('card', 'cash', 'bank_transfer')),
  constraint chip_order_documents_amount_check check (amount > 0),
  constraint chip_order_documents_attempts_check check (attempts >= 0),
  constraint chip_order_documents_key_check check (length(payment_key) between 6 and 160),
  constraint chip_order_documents_ref_check check (ref ~ '^[A-Z0-9]{6,16}$'),
  constraint chip_order_documents_error_check check (last_error is null or length(last_error) <= 500),
  constraint chip_order_documents_credit_check check (credit_of is null or kind = 'credit'),
  constraint chip_order_documents_issued_check check (
    (status = 'issued') = (issued_at is not null)
    and (status <> 'issued' or jsonb_array_length(morning_docs) > 0)
  ),
  constraint chip_order_documents_claim_check check ((status = 'issuing') = (claimed_at is not null))
);

create index chip_order_documents_order_idx on public.chip_order_documents (order_id);
create index chip_order_documents_due_idx on public.chip_order_documents (next_attempt_at)
  where status in ('pending', 'issuing');

comment on table public.chip_order_documents is
  'Morning documents of chip orders (26/11/2026): one row per payment (kind invoice) or refund (kind credit), written with the money movement; issued asynchronously and idempotently by src/lib/chipOrders/documents.ts. Never for a test order.';
comment on column public.chip_order_documents.payment_key is
  'One document per payment, ever: card:<processor transaction>, reception:<order id>, refund:<processor refund>, cancel:<order id>.';
comment on column public.chip_order_documents.morning_docs is
  'What Morning answered: [{type, id, number, url}] — the documents issued for this row, in order.';

-- migrate:down
do $$
begin
  if exists (select 1 from public.chip_order_documents) then
    raise exception 'chip_order_documents down: document rows exist (issued or queued) — refusing';
  end if;
end $$;
drop table public.chip_order_documents;
