-- migrate:up
-- "שקיפות כספית" — Slice A: manual income/expense entry (admin side only).
--
-- Product order (Decisions Log 21/09/2026): manual entry (this slice) → ledger
-- import → receipt scanning → owners portal (owners only, WhatsApp-code login).
-- This slice adds: dynamic categories (start EMPTY — no seed), per-month manual
-- entries with attached receipts in the PRIVATE bucket `finance-receipts`, a
-- background backup of every receipt to Google Drive (drive.file scope, the
-- lahav.yeadim@gmail.com account), and the global "show documents to residents"
-- switch, stored OFF and merely persisted here — enforcement is the portal's.
--
-- Closed decisions honoured by the shape below: no Bllink/bank link, no
-- extraction/approval queue (every saved row is final), one row per month (no
-- standing orders), no payment-method column, an expense counts in full in the
-- month of payment_date, supplier name + internal note are internal-only.
--
-- Access: admin / super_admin only — enforced in Node (module `finance`, deny by
-- default for the matrix roles). Like every other table here: no GRANT, no RLS
-- (the app reaches Postgres through one service pool; see src/lib/db.ts).
--
-- Storage: object key = <uuid>.<ext> (ASCII); the Hebrew name lives only in
-- fin_documents.original_name; the browser reaches a file only through
-- /api/files/finance-receipts/<key>. Uploads are STAGED (entry_id NULL, owned by
-- uploaded_by) and linked on save — the same lifecycle as wa_*_attachments, so
-- the Storage GC (scripts/storage-cleanup.ts) treats them the same way and stamps
-- object_deleted_at when it collects an abandoned upload.

create table public.fin_categories (
  id            uuid primary key default gen_random_uuid(),
  kind          text not null,
  name          text not null,
  sort_order    integer not null default 0,
  is_active     boolean not null default true,
  is_hot_water  boolean not null default false,
  section       text not null default 'operating',
  created_at    timestamptz not null default now(),
  created_by    uuid references public.users(id) on delete set null,
  constraint fin_categories_kind_check    check (kind in ('income', 'expense')),
  constraint fin_categories_section_check check (section in ('operating', 'renovation_fund')),
  constraint fin_categories_kind_name_key unique (kind, name)
);

create index fin_categories_kind_sort_idx on public.fin_categories (kind, sort_order, name);

comment on table public.fin_categories is
  'Income/expense categories of the building finance module. Dynamic, start empty (no seed). A category with entries is never deleted — only deactivated.';
comment on column public.fin_categories.section is
  'operating = the running budget; renovation_fund = קרן שיפוצים, shown apart from the operating totals.';
comment on column public.fin_categories.is_hot_water is
  'Flags the hot-water category so it can be told apart in reports (no behaviour in slice A).';

create table public.fin_entries (
  id              uuid primary key default gen_random_uuid(),
  kind            text not null,
  category_id     uuid not null references public.fin_categories(id) on delete restrict,
  period_month    date not null,
  amount          numeric(12,2) not null,
  description     text not null default '',
  internal_note   text not null default '',
  supplier_id     uuid references public.suppliers(id) on delete set null,
  supplier_name   text not null default '',
  invoice_number  text not null default '',
  payment_date    date,
  source          text not null default 'manual',
  created_by      uuid references public.users(id) on delete set null,
  created_at      timestamptz not null default now(),
  updated_by      uuid references public.users(id) on delete set null,
  updated_at      timestamptz not null default now(),
  deleted_at      timestamptz,
  deleted_by      uuid references public.users(id) on delete set null,
  constraint fin_entries_kind_check   check (kind in ('income', 'expense')),
  constraint fin_entries_source_check check (source in ('manual', 'ledger_import', 'scan')),
  constraint fin_entries_amount_check check (amount > 0),
  constraint fin_entries_period_month_check check (period_month = date_trunc('month', period_month)::date),
  constraint fin_entries_expense_payment_date_check check (kind = 'income' or payment_date is not null)
);

create index fin_entries_period_idx on public.fin_entries (period_month) where deleted_at is null;
create index fin_entries_category_idx on public.fin_entries (category_id);
create index fin_entries_invoice_idx on public.fin_entries (lower(invoice_number), supplier_id) where deleted_at is null;

create trigger fin_entries_touch_updated_at
  before update on public.fin_entries
  for each row execute function public.touch_updated_at();

comment on table public.fin_entries is
  'One income or expense line of the building, entered per month. Soft-deleted (deleted_at/deleted_by); an expense counts in full in the month of payment_date (period_month is derived from it).';
comment on column public.fin_entries.period_month is
  'The first day of the month the line belongs to. For an expense it is derived from payment_date; for an income it is the month the operator picked.';
comment on column public.fin_entries.supplier_name is
  'Internal only (never shown to residents). Copied from suppliers.display_name when supplier_id is set, or free text when the supplier is not in the table.';
comment on column public.fin_entries.description is
  'The text a resident will see in the future portal (with the category and the amount).';
comment on column public.fin_entries.internal_note is
  'Internal only — never shown to residents.';
comment on column public.fin_entries.source is
  'manual (this slice) | ledger_import | scan — the later slices write the other two.';

create table public.fin_documents (
  id                 uuid primary key default gen_random_uuid(),
  entry_id           uuid references public.fin_entries(id) on delete cascade,
  uploaded_by        uuid references public.users(id) on delete set null,
  bucket             text not null default 'finance-receipts',
  object_key         text not null unique,
  original_name      text not null,
  mime               text not null,
  size               bigint not null,
  drive_file_id      text,
  drive_status       text not null default 'pending',
  drive_error        text,
  drive_attempts     integer not null default 0,
  object_deleted_at  timestamptz,
  created_at         timestamptz not null default now(),
  constraint fin_documents_size_check         check (size > 0),
  constraint fin_documents_drive_status_check check (drive_status in ('pending', 'done', 'failed'))
);

create index fin_documents_entry_idx on public.fin_documents (entry_id, created_at);
create index fin_documents_staged_idx on public.fin_documents (uploaded_by, created_at) where entry_id is null;
create index fin_documents_drive_pending_idx on public.fin_documents (drive_status, created_at) where drive_status <> 'done';

comment on table public.fin_documents is
  'Receipts/invoices attached to a fin_entries row. entry_id NULL = uploaded but not yet saved with an entry (staged by uploaded_by). Each file is backed up to Google Drive in the background: drive_status pending → done | failed, up to 5 attempts.';
comment on column public.fin_documents.object_key is
  'Storage key in `bucket` (finance-receipts, private) — <uuid>.<ext>, ASCII only. The readable name is original_name.';
comment on column public.fin_documents.object_deleted_at is
  'Stamped by the Storage GC when it removed an abandoned staged object. Non-null = the bytes are gone.';

create table public.fin_drive_connection (
  id                 smallint primary key default 1,
  email              text not null,
  refresh_token_enc  jsonb not null,
  root_folder_id     text,
  connected_at       timestamptz not null default now(),
  connected_by       uuid references public.users(id) on delete set null,
  constraint fin_drive_connection_single_row check (id = 1)
);

comment on table public.fin_drive_connection is
  'The ONE Google account whose Drive receives the receipt backups (scope drive.file). refresh_token_enc = AES-256-GCM blob {iv,ct,tag} under SETTINGS_ENC_KEY (src/lib/crypto/settings-cipher.ts). root_folder_id caches the id of the "ALMOG — קבלות" folder.';

create table public.fin_settings (
  id                            smallint primary key default 1,
  show_documents_to_residents   boolean not null default false,
  updated_at                    timestamptz not null default now(),
  updated_by                    uuid references public.users(id) on delete set null,
  constraint fin_settings_single_row check (id = 1)
);

comment on table public.fin_settings is
  'Single-row settings of the finance module. show_documents_to_residents is persisted here (default OFF) and enforced only by the future owners portal.';

insert into public.fin_settings (id) values (1);

-- migrate:down
drop table if exists public.fin_documents;
drop table if exists public.fin_entries;
drop table if exists public.fin_categories;
drop table if exists public.fin_drive_connection;
drop table if exists public.fin_settings;
