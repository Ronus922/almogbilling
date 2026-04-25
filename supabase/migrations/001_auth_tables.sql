-- 001_auth_tables.sql
-- Slice 1 — Custom auth tables in proj_billing.public.
-- Run: docker exec -i supabase-db psql -U postgres -d proj_billing < supabase/migrations/001_auth_tables.sql

create extension if not exists pgcrypto;

create table if not exists public.users (
  id uuid primary key default gen_random_uuid(),
  username text unique not null,
  email text unique not null,
  password_hash text not null,
  full_name text,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index if not exists users_username_lower_idx on public.users (lower(username));
create unique index if not exists users_email_lower_idx    on public.users (lower(email));

create table if not exists public.sessions (
  id text primary key,
  user_id uuid not null references public.users(id) on delete cascade,
  expires_at timestamptz not null,
  remember boolean not null default false,
  created_at timestamptz not null default now()
);

create index if not exists sessions_user_idx    on public.sessions (user_id);
create index if not exists sessions_expires_idx on public.sessions (expires_at);

create table if not exists public.password_reset_tokens (
  token text primary key,
  user_id uuid not null references public.users(id) on delete cascade,
  expires_at timestamptz not null,
  used_at timestamptz,
  created_at timestamptz not null default now()
);

create index if not exists password_reset_tokens_user_idx on public.password_reset_tokens (user_id);

create or replace function public.touch_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists users_touch_updated_at on public.users;
create trigger users_touch_updated_at
  before update on public.users
  for each row execute function public.touch_updated_at();
