-- 063_worker_roles.sql
-- Field-worker roles: cleaner (עובד ניקיון) + maintenance (עובד אחזקה).
--
-- There is nothing to seed here. A role is not a row in this schema — it is a
-- text column constrained by a CHECK, and permissions are per-USER rows in
-- public.user_permissions written at user-creation time from the code-side
-- ROLE_DEFAULTS table (src/lib/permissions/constants.ts). So the entire DB-side
-- change is widening two CHECKs: users (the role itself) and user_invites
-- (without which a worker cannot even be invited).
--
-- Widening only. The new CHECK is a strict superset of the old one, so every
-- existing row passes by construction — verified before writing this migration:
-- 8/8 users and 6/6 invites already satisfy the new predicate. NOT VALID + an
-- explicit VALIDATE makes a violating row abort the transaction loudly rather
-- than the ADD failing halfway through.

BEGIN;

ALTER TABLE public.users DROP CONSTRAINT users_role_check;
ALTER TABLE public.users
  ADD CONSTRAINT users_role_check
  CHECK (role IN ('super_admin', 'admin', 'manager', 'viewer', 'cleaner', 'maintenance'))
  NOT VALID;
ALTER TABLE public.users VALIDATE CONSTRAINT users_role_check;

ALTER TABLE public.user_invites DROP CONSTRAINT user_invites_role_check;
ALTER TABLE public.user_invites
  ADD CONSTRAINT user_invites_role_check
  CHECK (role IN ('super_admin', 'admin', 'manager', 'viewer', 'cleaner', 'maintenance'))
  NOT VALID;
ALTER TABLE public.user_invites VALIDATE CONSTRAINT user_invites_role_check;

COMMIT;

-- ── DOWN ─────────────────────────────────────────────────────────────────────
-- Restores the pre-063 CHECKs. This FAILS by design if any cleaner/maintenance
-- user or invite still exists: reassign or delete them first. A down-migration
-- must not quietly narrow a constraint on rows it cannot represent.
--
-- BEGIN;
--
-- ALTER TABLE public.users DROP CONSTRAINT users_role_check;
-- ALTER TABLE public.users
--   ADD CONSTRAINT users_role_check
--   CHECK (role IN ('super_admin', 'admin', 'manager', 'viewer'));
--
-- ALTER TABLE public.user_invites DROP CONSTRAINT user_invites_role_check;
-- ALTER TABLE public.user_invites
--   ADD CONSTRAINT user_invites_role_check
--   CHECK (role IN ('super_admin', 'admin', 'manager', 'viewer'));
--
-- COMMIT;
