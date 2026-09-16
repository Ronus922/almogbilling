-- migrate:up

-- One row per run of the Storage garbage collector (scripts/storage-cleanup.ts,
-- billing-storage-cleanup.timer). The job deletes two kinds of object:
--
--   zombie      no DB row anywhere points at it — typically an attachment whose
--               campaign was deleted (wa_campaign_attachments cascades away and
--               leaves the object behind)
--   staged_old  an attachment row that was uploaded but never bound to a message
--               or campaign, and is now older than 24h — the leak the TODOs in
--               api/whatsapp/{campaigns,messages}/attachments/route.ts describe:
--               a user attaches a file and then closes the sheet
--
-- `linked` objects are live content and are never touched; `staged` objects
-- younger than 24h may still have an open compose window behind them.
--
-- mode = 'dry_run' is the default and writes a row exactly like a real run, with
-- objects_deleted = 0 — so the timer can report for weeks before anyone arms it.
-- summary carries the EXACT (bucket, key) list the run resolved, which is also
-- the only list the delete call is allowed to touch (CLAUDE.md iron rule 12).
create table public.storage_cleanup_runs (
    id               uuid primary key default gen_random_uuid(),
    started_at       timestamp with time zone not null default now(),
    finished_at      timestamp with time zone,
    mode             text not null default 'dry_run',
    status           text not null default 'running',
    error_stage      text,
    error_message    text,
    objects_scanned  integer not null default 0,
    objects_deleted  integer not null default 0,
    bytes_deleted    bigint  not null default 0,
    buckets_blocked  integer not null default 0,
    summary          jsonb,
    constraint storage_cleanup_runs_mode_check
      check (mode in ('dry_run', 'apply')),
    constraint storage_cleanup_runs_status_check
      check (status in ('running', 'success', 'error')),
    constraint storage_cleanup_runs_error_stage_check
      check (error_stage is null or error_stage in ('connect', 'list', 'cross_reference', 'delete', 'record'))
);

create index storage_cleanup_runs_started_at_idx on public.storage_cleanup_runs (started_at desc);

comment on table public.storage_cleanup_runs is
  'One row per Storage GC run (scripts/storage-cleanup.ts). summary = the exact per-bucket plan, including every key the run resolved and any bucket the safety brake blocked.';
comment on column public.storage_cleanup_runs.mode is
  'dry_run = resolved and recorded but deleted nothing (the default, and what the timer runs until phase 3); apply = actually removed the objects.';
comment on column public.storage_cleanup_runs.buckets_blocked is
  'Buckets the safety brake refused: more than 20% of the bucket selected for deletion, or the DB produced no pointers at all for a non-empty bucket (the signature of a broken cross-reference query).';

-- migrate:down

drop table if exists public.storage_cleanup_runs;
