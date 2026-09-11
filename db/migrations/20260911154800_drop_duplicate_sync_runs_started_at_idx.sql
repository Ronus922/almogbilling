-- migrate:up
-- 20260911134305 added sync_runs_started_at_idx (started_at desc), but
-- 017_sync_runs.sql already has the identical sync_runs_started_idx. Drop the duplicate.
drop index if exists public.sync_runs_started_at_idx;

-- migrate:down
create index if not exists sync_runs_started_at_idx on public.sync_runs (started_at desc);
