-- 009_invite_custom_permissions.sql
-- Slice 6d — Allow super_admin to customize the permissions matrix at invite time.
-- Stored as JSONB on user_invites; consumed by accept-invite to seed user_permissions.
-- NULL = use role defaults (legacy behavior + invites where matrix wasn't customized).

BEGIN;

ALTER TABLE public.user_invites
  ADD COLUMN IF NOT EXISTS custom_permissions jsonb;

COMMIT;
