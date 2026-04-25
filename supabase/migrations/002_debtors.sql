-- 002_debtors.sql
-- Slice 2 — Debtors table + Import runs + admin flag on users.

create table if not exists public.debtors (
  id                 uuid primary key default gen_random_uuid(),
  apartment_number   text not null unique,
  owner_name         text,
  tenant_name        text,
  address            text,
  phone_owner        text,
  phone_tenant       text,
  email_owner        text,
  email_tenant       text,
  phones_raw         text,
  operator_id        uuid,
  total_debt         numeric(10, 2) not null default 0,
  management_fees    numeric(10, 2) not null default 0,
  monthly_debt       text,
  hot_water_debt     numeric(10, 2) not null default 0,
  special_debt       numeric(10, 2) not null default 0,
  details            text,
  legal_status       text,
  is_archived        boolean not null default false,
  last_imported_at   timestamptz,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);

create unique index if not exists debtors_apt_idx          on public.debtors (apartment_number);
create        index if not exists debtors_legal_status_idx on public.debtors (legal_status);
create        index if not exists debtors_is_archived_idx  on public.debtors (is_archived);

drop trigger if exists debtors_touch_updated_at on public.debtors;
create trigger debtors_touch_updated_at
  before update on public.debtors
  for each row execute function public.touch_updated_at();

create table if not exists public.import_runs (
  id              uuid primary key default gen_random_uuid(),
  started_at      timestamptz not null default now(),
  finished_at     timestamptz,
  mode            text not null check (mode in ('merge', 'replace')),
  status          text not null default 'running'
                   check (status in ('running', 'success', 'error')),
  total_rows      integer not null default 0,
  processed_rows  integer not null default 0,
  updated_rows    integer not null default 0,
  created_rows    integer not null default 0,
  skipped_rows    integer not null default 0,
  error_message   text,
  initiated_by    uuid references public.users(id) on delete set null
);

create index if not exists import_runs_status_idx  on public.import_runs (status);
create index if not exists import_runs_started_idx on public.import_runs (started_at desc);

alter table public.users
  add column if not exists is_admin boolean not null default true;
