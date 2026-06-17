-- 036_users_allow_google_auth.sql
-- Per-user gate for Google Sign-In. Default false => Google login is opt-in;
-- an admin must explicitly enable it per user, otherwise the OAuth callback
-- blocks the attempt server-side (see src/app/api/auth/google/callback).
alter table public.users
  add column if not exists allow_google_auth boolean not null default false;
