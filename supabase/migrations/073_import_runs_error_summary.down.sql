-- 073_import_runs_error_summary.down.sql — reverses 073.
-- Run: psql "$DIRECT_URL" -f supabase/migrations/073_import_runs_error_summary.down.sql

begin;

alter table public.import_runs drop column if exists error_summary;

commit;
