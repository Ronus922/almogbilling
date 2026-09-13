-- migrate:up
-- Bllink shadow scraper (Phase 1 of the CRM-independence plan, 13/09/2026).
-- billing scrapes the Bllink "udnp" debt report itself (scripts/bllink-scrape.ts,
-- billing-bllink-scrape.timer 06:10 Asia/Jerusalem) and stores the RAW snapshot
-- here, then compares it with the CRM snapshot of the same morning. Nothing in
-- these tables feeds public.debtors — the existing CRM sync stays the only writer
-- until Phase 2 (BLLINK_SOURCE flag). Rows are kept 90 days (the script prunes).

create table public.bllink_scrapes (
  id              uuid primary key default gen_random_uuid(),
  started_at      timestamptz not null default now(),
  finished_at     timestamptz,
  status          text not null default 'running',
  error_stage     text,
  error_message   text,
  rows_count      integer,
  xlsx_sha256     text,
  compare_summary jsonb,
  constraint bllink_scrapes_status_check
    check (status in ('running', 'success', 'error')),
  constraint bllink_scrapes_error_stage_check
    check (error_stage is null or error_stage in ('login', 'navigate', 'download', 'parse', 'compare'))
);

create index bllink_scrapes_started_at_idx on public.bllink_scrapes (started_at desc);

comment on table public.bllink_scrapes is
  'One row per shadow scrape of the Bllink udnp report (scripts/bllink-scrape.ts). compare_summary = diff against the CRM snapshot of the same run.';

create table public.bllink_scrape_rows (
  id                    bigserial primary key,
  scrape_id             uuid not null references public.bllink_scrapes(id) on delete cascade,
  apartment_number      text not null,
  owner_name            text,
  phone_primary         text,
  total_debt            numeric(12,2) not null default 0,
  monthly_debt          numeric(12,2) not null default 0,
  special_debt          numeric(12,2) not null default 0,
  management_months_raw text,
  notes                 text,
  raw                   jsonb not null default '{}'::jsonb
);

create index bllink_scrape_rows_scrape_id_idx on public.bllink_scrape_rows (scrape_id);

comment on table public.bllink_scrape_rows is
  'Raw rows of one Bllink shadow scrape, in the CRM debtor_records column naming (D total, E monthly, F months text, G special, H notes). raw = the eight source cells.';

-- migrate:down
drop table if exists public.bllink_scrape_rows;
drop table if exists public.bllink_scrapes;
