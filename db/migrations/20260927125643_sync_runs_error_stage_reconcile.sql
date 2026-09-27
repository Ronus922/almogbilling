-- migrate:up
-- A fifth sync stage, 'reconcile' (27/09/2026): after the write, the sums in
-- public.debtors are compared per category (management fees / hot water) with
-- the Bllink report that was just copied, and any gap fails the run at this
-- stage (src/lib/sync/reconcile.ts). Widens the CHECK only — no data change.
alter table public.sync_runs drop constraint sync_runs_error_stage_check;
alter table public.sync_runs add constraint sync_runs_error_stage_check
  check (error_stage is null or error_stage = any (array['scrape', 'stale', 'guard', 'pull', 'reconcile']));
comment on column public.sync_runs.error_stage is
  'Stage that failed: scrape (Bllink download), stale (snapshot older than the freshness limit), guard (pre-write completeness/consistency of the snapshot), pull (fetch or write), reconcile (post-write: debtors sums per category or per apartment differ from the report)';

-- migrate:down
-- Runs recorded at the new stage cannot satisfy the old CHECK: fold them into
-- 'pull' (the write did happen) before narrowing the constraint back.
update public.sync_runs set error_stage = 'pull' where error_stage = 'reconcile';
alter table public.sync_runs drop constraint sync_runs_error_stage_check;
alter table public.sync_runs add constraint sync_runs_error_stage_check
  check (error_stage is null or error_stage = any (array['scrape', 'stale', 'guard', 'pull']));
comment on column public.sync_runs.error_stage is
  'Stage that failed: scrape (CRM/Bllink download), stale (snapshot older than BLLINK_MAX_SNAPSHOT_AGE_HOURS), guard (completeness/reconciliation), pull (fetch or write)';
