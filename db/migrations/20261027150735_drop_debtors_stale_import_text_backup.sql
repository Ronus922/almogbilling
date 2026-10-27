-- migrate:up
-- Drops the rollback snapshot of the 29/09/2026 stale-import-text cleanup
-- (migration 20260929043204): 59 rows holding the cleared debtors.details /
-- debtors.monthly_debt of apartments whose debt had been settled. Ronen
-- approved the drop on 27/10/2026 after the cleanup had been in production
-- for a month with no report of a wrong clearing.
--
-- THE DATA IS NOT COMING BACK FROM migrate:down. 30 of those 59 texts exist
-- nowhere else (the apartments left the Bllink report before 13/09/2026, so
-- bllink_scrape_rows cannot rebuild them). The deploy block takes a full
-- dump of the table to /var/billing-proof/ BEFORE this migration runs; that
-- dump is the only copy once it has.
--
-- Nothing in src/, scripts/ or tests/ reads the table; the only dependents
-- are its own primary key and its foreign key to debtors (both go with it).
-- IF EXISTS keeps the migration safe on a database that never had it.
drop table if exists public.debtors_stale_import_text_backup;

-- migrate:down
-- Restores the STRUCTURE only (same columns, key, foreign key and comment as
-- migration 20260929043204 created), EMPTY. That is deliberate: it is what
-- lets the older migration's own migrate:down still run (it joins this table
-- and then drops it) if someone ever rolls back past 20260929043204.
create table if not exists public.debtors_stale_import_text_backup (
  debtor_id        uuid primary key references public.debtors(id) on delete cascade,
  apartment_number text not null,
  details          text,
  monthly_debt     text,
  cleared_at       timestamptz not null default now()
);

comment on table public.debtors_stale_import_text_backup is
  'Pre-clearing snapshot of debtors.details / debtors.monthly_debt for apartments whose debt was fully settled (one-time cleanup 29/09/2026). Rollback source for migration 20260929043204; safe to drop once the cleanup is confirmed.';
