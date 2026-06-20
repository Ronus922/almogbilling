-- 052_supplier_categories_color.sql
-- Per-category badge color. Additive only: one nullable text column holding a
-- user-chosen hex ('#2563eb'); NULL = fall back to the deterministic name-hash
-- palette in the app (SupplierCategoryBadge). Validated app-side (COLOR_HEX_RE).
-- Non-destructive and idempotent (IF NOT EXISTS) — safe to re-run.
--
-- Run (DIRECT_URL, direct port 5432, for DDL):
--   psql "$DIRECT_URL" -f supabase/migrations/052_supplier_categories_color.sql

begin;

alter table public.supplier_categories
  add column if not exists color text;

commit;
