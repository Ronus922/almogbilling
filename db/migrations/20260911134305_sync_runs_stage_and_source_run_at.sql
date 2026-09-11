-- migrate:up
-- sync_runs: record WHY a Bllink sync failed and HOW FRESH the data it copied
-- was. Until 11/09/2026 a run was only success/error + free text, so a scrape
-- that failed upstream (CRM answered 200 with downloaded=false) was recorded as
-- a success and the dashboard kept re-copying a 25/08 snapshot for 17 days.
alter table public.sync_runs
  add column error_stage    text,
  add column source_run_at  timestamp with time zone,
  add column rows_count     integer,
  add column import_run_id  uuid references public.import_runs(id) on delete set null,
  add column trigger_source text not null default 'ui';

alter table public.sync_runs
  add constraint sync_runs_error_stage_check
    check (error_stage is null or error_stage in ('scrape', 'stale', 'guard', 'pull'));

alter table public.sync_runs
  add constraint sync_runs_trigger_source_check
    check (trigger_source in ('ui', 'cron'));

comment on column public.sync_runs.error_stage    is 'Stage that failed: scrape (CRM/Bllink download), stale (snapshot older than BLLINK_MAX_SNAPSHOT_AGE_HOURS), guard (completeness/reconciliation), pull (fetch or write)';
comment on column public.sync_runs.source_run_at  is 'last_import_at of the CRM snapshot this run read — the moment Bllink was actually scraped; the dashboard shows this, not the copy time';
comment on column public.sync_runs.rows_count     is 'Apartments written by a successful run';
comment on column public.sync_runs.trigger_source is 'ui = "סנכרן עכשיו" button (triggered_by set) · cron = billing-sync.timer via x-cron-secret (triggered_by null)';

create index sync_runs_started_at_idx on public.sync_runs (started_at desc);

-- migrate:down
drop index if exists public.sync_runs_started_at_idx;
alter table public.sync_runs drop constraint if exists sync_runs_trigger_source_check;
alter table public.sync_runs drop constraint if exists sync_runs_error_stage_check;
alter table public.sync_runs
  drop column if exists trigger_source,
  drop column if exists import_run_id,
  drop column if exists rows_count,
  drop column if exists source_run_at,
  drop column if exists error_stage;
