-- migrate:up
-- A soft delete is an UPDATE, and Postgres re-checks a NOT VALID check on every
-- updated row: an issued document that predates the constraint (no supplier)
-- could not be deleted (purchasing_documents_has_supplier violated). A deleted
-- row is out of every list, so the rule no longer applies to it.
alter table public.purchasing_documents drop constraint purchasing_documents_has_supplier;
alter table public.purchasing_documents
  add constraint purchasing_documents_has_supplier check (
    deleted_at is not null
    or (status = 'draft' or supplier_id is not null or nullif(btrim(coalesce(supplier_name, '')), '') is not null)
  ) not valid;

-- migrate:down
alter table public.purchasing_documents drop constraint purchasing_documents_has_supplier;
alter table public.purchasing_documents
  add constraint purchasing_documents_has_supplier check (
    status = 'draft' or supplier_id is not null or nullif(btrim(coalesce(supplier_name, '')), '') is not null
  ) not valid;
