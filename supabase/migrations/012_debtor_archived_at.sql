-- 012_debtor_archived_at.sql
-- Adds a timestamp recording WHEN a debtor was moved to the archive.
-- `is_archived` (boolean) already gates the archive tab; `archived_at` powers
-- the "הועבר לארכיון" date column. Both are kept in sync by the archive route.

alter table public.debtors
  add column if not exists archived_at timestamptz null default null;

-- Backfill any pre-existing archived rows so they show a date instead of "—".
update public.debtors
   set archived_at = now()
 where is_archived = true
   and archived_at is null;
