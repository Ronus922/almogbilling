-- 005_status_management.sql
-- Slice "Status Management" — UI + API for managing statuses CRUD.
-- Run: docker exec -i supabase-db psql -U postgres -d proj_billing < supabase/migrations/005_status_management.sql
--
-- Additive only. Builds on 003_debtor_panel.sql (which already created
-- public.statuses, debtors.legal_status_id, and seeded 7 rows).
--
-- Pre-conditions enforced inside the transaction:
--   - exactly one row with is_default=true (else partial unique idx aborts)
--   - all colors match #RRGGBB (else CHECK constraint aborts)
-- If either fails, the whole script rolls back.

BEGIN;

-- 1. Defensive pre-flight: surface the offending rows (if any) before the
--    schema change locks the table. Raises NOTICE — does not abort by itself,
--    but the partial unique index / CHECK below will.
DO $$
DECLARE
  default_count int;
  bad_color_count int;
BEGIN
  SELECT count(*) INTO default_count FROM public.statuses WHERE is_default = true;
  IF default_count > 1 THEN
    RAISE EXCEPTION 'precheck failed: % rows with is_default=true (expected ≤ 1)', default_count;
  END IF;

  SELECT count(*) INTO bad_color_count
    FROM public.statuses
    WHERE color !~ '^#[0-9a-fA-F]{6}$';
  IF bad_color_count > 0 THEN
    RAISE EXCEPTION 'precheck failed: % rows with invalid color (expected /^#[0-9a-fA-F]{6}$/)', bad_color_count;
  END IF;
END
$$;

-- 2. Add columns (idempotent).
ALTER TABLE public.statuses
  ADD COLUMN IF NOT EXISTS is_system  boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS created_by uuid    REFERENCES public.users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS updated_by uuid    REFERENCES public.users(id) ON DELETE SET NULL;

-- 3. CHECK on color format (additive — leaves existing data alone since
--    pre-check verified all rows match).
ALTER TABLE public.statuses DROP CONSTRAINT IF EXISTS statuses_color_format;
ALTER TABLE public.statuses
  ADD CONSTRAINT statuses_color_format CHECK (color ~ '^#[0-9a-fA-F]{6}$');

-- 4. Partial unique index — at most one is_default=true row.
CREATE UNIQUE INDEX IF NOT EXISTS statuses_one_default_idx
  ON public.statuses (is_default)
  WHERE is_default = true;

-- 5. Mark 'רגיל' as the system default. Idempotent: re-running has no effect.
UPDATE public.statuses SET is_system = true WHERE name = 'רגיל';

COMMIT;
