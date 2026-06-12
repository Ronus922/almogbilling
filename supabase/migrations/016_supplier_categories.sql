-- 016_supplier_categories.sql
-- Adds a user-managed category taxonomy to the suppliers module, so suppliers
-- can be classified beyond the fixed `supplier_type` enum (e.g. service
-- providers / tradespeople grouped by trade).
--
-- Additive only and idempotent:
--   - supplier_categories: small lookup table (disabled via is_active=false;
--     hard-deletable only when no live supplier references it — enforced in the
--     API layer, mirroring the status-deletion guard).
--   - suppliers.category_id: optional FK, ON DELETE SET NULL so a category can
--     be removed once no live supplier uses it without losing the supplier.
--   - opening category seed.
--
-- Run: docker exec -i supabase-db psql -U postgres -d proj_billing < supabase/migrations/016_supplier_categories.sql

BEGIN;

CREATE TABLE IF NOT EXISTS public.supplier_categories (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name        text NOT NULL UNIQUE,
  is_active   boolean NOT NULL DEFAULT true,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

DROP TRIGGER IF EXISTS supplier_categories_touch_updated_at ON public.supplier_categories;
CREATE TRIGGER supplier_categories_touch_updated_at
  BEFORE UPDATE ON public.supplier_categories
  FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();

ALTER TABLE public.suppliers
  ADD COLUMN IF NOT EXISTS category_id uuid REFERENCES public.supplier_categories(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_suppliers_category
  ON public.suppliers (category_id) WHERE deleted_at IS NULL;

-- Opening categories (idempotent — name is UNIQUE).
INSERT INTO public.supplier_categories (name)
VALUES ('אינסטלציה'), ('חשמל'), ('מעליות'), ('ניקיון'),
       ('גינון'), ('אינטרקום'), ('כללי')
ON CONFLICT (name) DO NOTHING;

COMMIT;
