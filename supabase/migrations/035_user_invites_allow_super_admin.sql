-- 035_user_invites_allow_super_admin.sql
-- Allow super_admin invites. Until now user_invites.role was constrained to
-- {admin, manager, viewer}, so a super_admin granting super_admin via the UI
-- (POST /api/users) failed at INSERT with a check-constraint violation (500).
--
-- ADDITIVE / WIDENING ONLY. Replaces the role CHECK with one that also permits
-- 'super_admin', matching public.users_role_check. No data is migrated; every
-- existing invite already satisfies the wider set. Idempotent.
--
-- WHO may actually grant super_admin is enforced in the app layer
-- (canManageRole: super_admin only) — the constraint just stops being a blocker.
--
-- Run: psql "$DIRECT_URL" -f supabase/migrations/035_user_invites_allow_super_admin.sql

ALTER TABLE public.user_invites DROP CONSTRAINT IF EXISTS user_invites_role_check;

ALTER TABLE public.user_invites
  ADD CONSTRAINT user_invites_role_check
  CHECK (role = ANY (ARRAY['super_admin'::text, 'admin'::text, 'manager'::text, 'viewer'::text]));
