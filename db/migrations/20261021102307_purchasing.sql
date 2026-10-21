-- migrate:up
-- Purchasing ("רכש", 21/10/2026): two documents only — a request for quotation
-- (בקשה להצעת מחיר, doc_type 'rfq') and a purchase order (הזמנת רכש, 'po').
-- Strictly additive: eight new tables, nothing existing is altered. In
-- particular there is NO link to the finance module (fin_*), to the renovation
-- fund or to the portal, and `suppliers` is only read (FK from here).
--
-- Numbering: one atomic counter per series (purchasing_sequences). The first
-- document of a series carries the owner's starting number; from then on the
-- number is last_number + 1 under a row lock, so two parallel saves can never
-- get the same number (and (doc_type, number) is UNIQUE as a backstop).
--
-- Permission: module `purchasing` — super admin only by default. Like
-- `finance` / `portal_*` it is deny-by-default for every matrix role (no
-- user_permissions row = denied), so no row is seeded here.

create table public.purchasing_sequences (
  doc_type    text primary key check (doc_type in ('rfq', 'po')),
  last_number integer not null check (last_number >= 0),
  updated_at  timestamptz not null default now()
);

create table public.purchasing_documents (
  id                 uuid primary key default gen_random_uuid(),
  doc_type           text not null check (doc_type in ('rfq', 'po')),
  number             integer not null check (number > 0),
  doc_date           date not null,
  title              text not null default '',
  -- po: the supplier it is addressed to. rfq: null (its addressees are the
  -- rows of purchasing_rfq_recipients).
  supplier_id        uuid references public.suppliers(id) on delete restrict,
  notes              text not null default '',
  -- rfq only: last day a supplier may submit / amend a quote.
  due_date           date,
  -- Stamped at issue time; a later change of the company VAT rate never
  -- touches an issued document.
  vat_rate           numeric(5,2) not null check (vat_rate >= 0 and vat_rate <= 100),
  -- po opened from a winning quote.
  source_rfq_id      uuid references public.purchasing_documents(id) on delete set null,
  -- rfq only: the chosen supplier (one per request) — who chose, and when.
  winner_supplier_id uuid references public.suppliers(id) on delete restrict,
  winner_chosen_by   uuid references public.users(id) on delete set null,
  winner_chosen_at   timestamptz,
  created_by         uuid references public.users(id) on delete set null,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  deleted_at         timestamptz,
  constraint purchasing_documents_title_length check (char_length(title) <= 200),
  constraint purchasing_documents_notes_length check (char_length(notes) <= 4000),
  constraint purchasing_documents_rfq_has_due check (doc_type <> 'rfq' or due_date is not null),
  constraint purchasing_documents_po_has_supplier check (doc_type <> 'po' or supplier_id is not null),
  constraint purchasing_documents_winner_only_rfq check (
    winner_supplier_id is null or doc_type = 'rfq'
  )
);
-- Soft delete must not free a number for reuse: the unique index ignores
-- deleted_at on purpose.
create unique index purchasing_documents_number_uidx
  on public.purchasing_documents (doc_type, number);
create index purchasing_documents_list_idx
  on public.purchasing_documents (doc_type, doc_date desc, number desc)
  where deleted_at is null;
create index purchasing_documents_supplier_idx
  on public.purchasing_documents (supplier_id) where supplier_id is not null;
create index purchasing_documents_source_rfq_idx
  on public.purchasing_documents (source_rfq_id) where source_rfq_id is not null;

create table public.purchasing_lines (
  id          uuid primary key default gen_random_uuid(),
  document_id uuid not null references public.purchasing_documents(id) on delete cascade,
  sort_order  integer not null,
  description text not null check (char_length(description) between 1 and 500),
  quantity    numeric(12,3) not null check (quantity > 0),
  -- po: required by the app. rfq: always null (the request carries no prices).
  unit_price  numeric(12,2) check (unit_price is null or unit_price >= 0)
);
create index purchasing_lines_document_idx
  on public.purchasing_lines (document_id, sort_order);
-- Feeds the "פירוט" autocomplete (distinct descriptions entered before).
create index purchasing_lines_description_idx
  on public.purchasing_lines (description);

-- One row per (request, supplier it was sent to). `token` is the personal
-- public link: 32 random bytes, base64url. It is kept in clear (not hashed)
-- because the same link must be re-sendable; it is unguessable, scoped to this
-- request + supplier, rate-limited, and the page exposes nothing else.
create table public.purchasing_rfq_recipients (
  id              uuid primary key default gen_random_uuid(),
  rfq_id          uuid not null references public.purchasing_documents(id) on delete cascade,
  supplier_id     uuid not null references public.suppliers(id) on delete restrict,
  token           text not null unique check (char_length(token) >= 32),
  created_at      timestamptz not null default now(),
  first_viewed_at timestamptz,
  last_viewed_at  timestamptz,
  unique (rfq_id, supplier_id)
);

-- A supplier's offer on a request: from its public link ('portal') or keyed in
-- by staff from an e-mail / a file ('manual'). One per (request, supplier).
-- total_amount (before VAT) is used when the offer has no per-line prices.
create table public.purchasing_quotes (
  id           uuid primary key default gen_random_uuid(),
  rfq_id       uuid not null references public.purchasing_documents(id) on delete cascade,
  supplier_id  uuid not null references public.suppliers(id) on delete restrict,
  source       text not null check (source in ('portal', 'manual')),
  total_amount numeric(12,2) check (total_amount is null or total_amount >= 0),
  valid_until  date,
  notes        text not null default '' check (char_length(notes) <= 2000),
  submitted_at timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  created_by   uuid references public.users(id) on delete set null,
  unique (rfq_id, supplier_id)
);

create table public.purchasing_quote_lines (
  quote_id   uuid not null references public.purchasing_quotes(id) on delete cascade,
  line_id    uuid not null references public.purchasing_lines(id) on delete cascade,
  unit_price numeric(12,2) not null check (unit_price >= 0),
  primary key (quote_id, line_id)
);

-- Files: attached to a document (staff) or to a quote (the supplier's, or
-- staff's for an offer received outside the system). The bytes are in the
-- PRIVATE bucket `purchasing-files`, key = <uuid>.<ext> only; the readable
-- name lives here. Served only through /api/files (staff) or the supplier's
-- token route.
create table public.purchasing_files (
  id                uuid primary key default gen_random_uuid(),
  document_id       uuid references public.purchasing_documents(id) on delete cascade,
  quote_id          uuid references public.purchasing_quotes(id) on delete cascade,
  bucket            text not null default 'purchasing-files',
  object_key        text not null unique,
  original_filename text not null,
  mime_type         text not null,
  file_size         bigint not null check (file_size > 0),
  uploaded_via      text not null check (uploaded_via in ('staff', 'supplier')),
  uploaded_by       uuid references public.users(id) on delete set null,
  created_at        timestamptz not null default now(),
  constraint purchasing_files_one_owner check ((document_id is null) <> (quote_id is null))
);
create index purchasing_files_document_idx on public.purchasing_files (document_id) where document_id is not null;
create index purchasing_files_quote_idx on public.purchasing_files (quote_id) where quote_id is not null;

-- Every send of a document to a supplier, per channel (the audit trail the
-- screen shows next to each recipient).
create table public.purchasing_dispatches (
  id          uuid primary key default gen_random_uuid(),
  document_id uuid not null references public.purchasing_documents(id) on delete cascade,
  supplier_id uuid not null references public.suppliers(id) on delete restrict,
  channel     text not null check (channel in ('email', 'whatsapp')),
  status      text not null check (status in ('sent', 'failed')),
  error       text,
  sent_by     uuid references public.users(id) on delete set null,
  sent_at     timestamptz not null default now()
);
create index purchasing_dispatches_document_idx on public.purchasing_dispatches (document_id, sent_at desc);

comment on table public.purchasing_documents is
  'Purchasing: request for quotation (rfq) and purchase order (po). Separate number series per doc_type (purchasing_sequences).';
comment on column public.purchasing_documents.vat_rate is
  'VAT percent stamped when the document was issued — later changes of the company setting do not touch it.';
comment on column public.purchasing_rfq_recipients.token is
  'Personal public link token of one supplier for one request: unguessable, scoped to (rfq, supplier). Public route /quote/<token>.';
comment on column public.purchasing_quotes.total_amount is
  'Offer total BEFORE VAT, for an offer without per-line prices (e.g. a file received by e-mail). Ignored when every request line has a price.';

-- migrate:down
drop table if exists public.purchasing_dispatches;
drop table if exists public.purchasing_files;
drop table if exists public.purchasing_quote_lines;
drop table if exists public.purchasing_quotes;
drop table if exists public.purchasing_rfq_recipients;
drop table if exists public.purchasing_lines;
drop table if exists public.purchasing_documents;
drop table if exists public.purchasing_sequences;
