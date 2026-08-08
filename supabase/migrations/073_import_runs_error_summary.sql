-- 073_import_runs_error_summary.sql
-- import_runs.error_summary — human-readable (Hebrew) per-run summary line for
-- the import UI, e.g. how many contacts rows the registry hook created with
-- needs_review=true. Distinct from error_message (failure text) and
-- error_details (per-row failure jsonb).
-- DOWN: 073_import_runs_error_summary.down.sql (separate file).
-- Run: psql "$DIRECT_URL" -f supabase/migrations/073_import_runs_error_summary.sql

begin;

alter table public.import_runs add column if not exists error_summary text;

commit;
