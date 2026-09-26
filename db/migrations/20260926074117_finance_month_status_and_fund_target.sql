-- migrate:up
-- "שקיפות כספית" — month publishing + the renovation-fund collection target.
--
-- Decisions (Decisions Log 26/09/2026):
--   • The renovation fund stays modelled by the CATEGORY: fin_categories.section
--     = 'renovation_fund' is the single source of truth; every fund line (income
--     included) carries a fund category, and a fund expense's category is its
--     "מטרה" (purpose). No fund column, no purposes table, category_id stays
--     NOT NULL. The fund KPIs are cumulative over all months.
--   • A month is shown to residents only once an admin PUBLISHES it. This
--     replaces the earlier "real time, no publish step" idea. A month with no
--     row here is unpublished. The future owners portal reads only published
--     months — the filter is in the queries (src/lib/db/finance/portal.ts),
--     never in the UI.
--
-- Additive only: two new tables, nothing existing changes. Like every table
-- here: no GRANT, no RLS (one service pool, see src/lib/db.ts).

create table public.finance_month_status (
  year          integer not null,
  month         integer not null,
  published     boolean not null default false,
  published_at  timestamptz,
  published_by  uuid references public.users(id) on delete set null,
  constraint finance_month_status_pkey primary key (year, month),
  constraint finance_month_status_year_month_key unique (year, month),
  constraint finance_month_status_month_check check (month between 1 and 12),
  constraint finance_month_status_year_check check (year between 2000 and 2100)
);

comment on table public.finance_month_status is
  'Per-month resident visibility of the finance module. No row = not published. published_at / published_by record the LAST toggle (either direction).';

create table public.renovation_fund_settings (
  id             smallint primary key default 1,
  target_amount  numeric(12,2) not null default 0,
  updated_at     timestamptz not null default now(),
  updated_by     uuid references public.users(id) on delete set null,
  constraint renovation_fund_settings_single_row check (id = 1),
  constraint renovation_fund_settings_target_check check (target_amount >= 0)
);

comment on table public.renovation_fund_settings is
  'Single row: the renovation fund collection target (יעד גבייה) the cumulative KPI is measured against.';

insert into public.renovation_fund_settings (id) values (1);

-- migrate:down
drop table if exists public.renovation_fund_settings;
drop table if exists public.finance_month_status;
