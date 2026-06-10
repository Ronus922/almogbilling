-- 008_simplify_permissions.sql
-- Slice 6c — Simplify permissions matrix from 3 tiers (view/edit/delete) to 2 (view/edit).
-- "edit" now covers all mutations within a module: update, delete, export, send-message, etc.

BEGIN;

-- Defense in depth: if any row has can_delete=true while can_edit=false,
-- promote can_edit so we don't silently revoke an existing capability.
-- (In practice the table is empty at the time of this migration — no
--  manager/viewer users exist yet — so this is a no-op.)
UPDATE public.user_permissions SET can_edit = true WHERE can_delete = true AND can_edit = false;

ALTER TABLE public.user_permissions DROP COLUMN can_delete;

COMMIT;
