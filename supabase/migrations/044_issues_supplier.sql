-- 044_issues_supplier.sql
-- Issues → supplier link. Adds a dedicated supplier_id dimension to issues — the
-- external contractor / vendor handling the fault — kept SEPARATE from location
-- (where the fault is) and assigned_to_user_id (the internal employee).
--
-- Additive only: one nullable column + FK + index. No existing column is touched.
-- FK is ON DELETE SET NULL so deleting a supplier never deletes issues — it only
-- detaches them.
--
-- Run: docker exec -i supabase-db psql -U postgres -d proj_billing < supabase/migrations/044_issues_supplier.sql

begin;

alter table public.issues
  add column if not exists supplier_id uuid
    references public.suppliers(id) on delete set null;

create index if not exists idx_issues_supplier on public.issues (supplier_id);

commit;
