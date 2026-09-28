-- migrate:up
-- Owners portal, 28/09/2026: a hand-entered bank balance per month (the
-- finance admin types it next to the month's publish switch) and the switch
-- that lets residents see it. Additive only; every column is nullable or has
-- a default, so existing rows and code are untouched.
alter table public.finance_month_status
  add column if not exists bank_balance numeric(12,2),
  add column if not exists bank_balance_updated_at timestamptz,
  add column if not exists bank_balance_updated_by uuid references public.users(id) on delete set null;

comment on column public.finance_month_status.bank_balance is
  'Bank balance at the end of the month, entered by hand on /finance. NULL = not entered. Shown to residents only while fin_settings.show_bank_balance_to_residents is on.';

alter table public.fin_settings
  add column if not exists show_bank_balance_to_residents boolean not null default false;

-- migrate:down
alter table public.fin_settings drop column if exists show_bank_balance_to_residents;
alter table public.finance_month_status
  drop column if exists bank_balance_updated_by,
  drop column if exists bank_balance_updated_at,
  drop column if exists bank_balance;
