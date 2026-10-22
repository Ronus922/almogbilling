-- migrate:up
-- Purchasing form alignment (22/10/2026), approved by Ronen for the purchasing_*
-- tables only (created 21/10/2026, nothing else is touched):
--   * the form's "תיאור" is optional      -> title becomes nullable
--   * the form's supplier is ONE field: a supplier from the list, or a name
--     typed by hand -> a supplier_id (already nullable) OR a free supplier_name
--     plus optional phone / e-mail / address, kept on the document only (they
--     are never added to public.suppliers)
-- The old rule "a purchase order must have supplier_id" is replaced by "every
-- document has a supplier, from the list or typed". NOT VALID: rows that
-- predate this migration are not re-checked.

alter table public.purchasing_documents alter column title drop not null;
alter table public.purchasing_documents alter column title drop default;

alter table public.purchasing_documents
  add column supplier_name    text,
  add column supplier_phone   text,
  add column supplier_email   text,
  add column supplier_address text;

alter table public.purchasing_documents
  add constraint purchasing_documents_supplier_text_length check (
    char_length(coalesce(supplier_name, ''))    <= 200 and
    char_length(coalesce(supplier_phone, ''))   <= 40  and
    char_length(coalesce(supplier_email, ''))   <= 200 and
    char_length(coalesce(supplier_address, '')) <= 300
  );

alter table public.purchasing_documents drop constraint purchasing_documents_po_has_supplier;
alter table public.purchasing_documents
  add constraint purchasing_documents_has_supplier check (
    supplier_id is not null or nullif(btrim(coalesce(supplier_name, '')), '') is not null
  ) not valid;

comment on column public.purchasing_documents.supplier_name is
  'Supplier typed by hand (not in public.suppliers). Used only when supplier_id is null.';

-- migrate:down
-- Fails loudly if a document with a hand-typed supplier exists (a purchase
-- order without supplier_id would violate the restored rule): remove or link
-- those documents first.
alter table public.purchasing_documents drop constraint purchasing_documents_has_supplier;
alter table public.purchasing_documents drop constraint purchasing_documents_supplier_text_length;
alter table public.purchasing_documents
  add constraint purchasing_documents_po_has_supplier check (doc_type <> 'po' or supplier_id is not null);
alter table public.purchasing_documents
  drop column supplier_address,
  drop column supplier_email,
  drop column supplier_phone,
  drop column supplier_name;
update public.purchasing_documents set title = '' where title is null;
alter table public.purchasing_documents alter column title set default '';
alter table public.purchasing_documents alter column title set not null;
