-- 075_seed_qa_viewer.sql
-- Permanent QA viewer account: qa-viewer ("QA צופה"), role=viewer, active,
-- with EXACTLY ONE permission row — dashboard:view. It exists so fail-closed
-- permission checks can be exercised end-to-end with a real 200-capable
-- session (until now the only verification path was the 401 of no session).
--
-- This is NOT test data: it is a standing account, excluded from QA cleanups
-- (see PROJECT_CONTEXT.md). The password is not here — only its bcrypt hash;
-- the plaintext lives in /etc/billing/qa-viewer.txt (root:root, 600).
--
-- Idempotent: the user insert is keyed on username; the permission seed
-- deletes+reinserts the full (one-row) set for this user, mirroring the
-- migration-side user_permissions seed pattern of 041.

begin;

insert into public.users (username, email, password_hash, full_name, role, is_active)
values (
  'qa-viewer',
  'qa-viewer@billing.local',
  '$2b$10$SY7mGbmGFjQDMfx5Titlq.iQqDLd1teqd1Ga9STItE84EQ33YH5Py',
  'QA צופה',
  'viewer',
  true
)
on conflict (username) do nothing;

delete from public.user_permissions
 where user_id in (select id from public.users where username = 'qa-viewer');

insert into public.user_permissions (user_id, module, can_view, can_edit)
select id, 'dashboard', true, false
  from public.users
 where username = 'qa-viewer';

commit;
