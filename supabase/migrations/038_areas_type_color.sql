-- 038_areas_type_color.sql
-- Aligns public.areas (created in 037) to the final Areas schema.
-- Additive + idempotent — does NOT edit 037, which is already applied.
--
-- Final schema for the module is: id / name / area_type / description / color
-- + created_by + timestamps. This migration adds the two missing columns:
--   - area_type  text not null, enum {'closed_room','open_space'} (חדר סגור / מרחב פתוח)
--   - color      text null      (hex card color, e.g. '#3d5afe')
-- area_type carries a safe default ('closed_room') so the NOT NULL is satisfied
-- for any pre-existing row and for raw inserts — mirrors suppliers.supplier_type.
--
-- responsible_contact_id from 037 is intentionally left in place (this migration
-- is additive). The application no longer reads or writes it.
--
-- Run: set -a; source <(sudo cat /etc/billing/billing.env); set +a
--      psql "$DIRECT_URL" -f supabase/migrations/038_areas_type_color.sql

BEGIN;

ALTER TABLE public.areas
  ADD COLUMN IF NOT EXISTS area_type text NOT NULL DEFAULT 'closed_room';

ALTER TABLE public.areas
  ADD COLUMN IF NOT EXISTS color text;

DO $$ BEGIN
  ALTER TABLE public.areas ADD CONSTRAINT areas_area_type_check
    CHECK (area_type IN ('closed_room', 'open_space'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

COMMIT;
