-- migrate:up
-- One-time cleanup, 29/09/2026: the import's free-text fields left behind on
-- apartments whose debt was fully settled.
--
-- Until the fix in src/lib/import/clearing.ts, the merge-mode clearing zeroed
-- the amounts of an apartment that had left the Bllink report but kept
-- debtors.details — so a settled apartment (1421: dropped out of the 28/09
-- report, amounts 0) still showed "מים חמים 05-06/25, …" on the tenant panel,
-- on the print sheet and in the owner's own portal, next to a ₪0 balance.
-- 59 non-archived rows were in that state (monthly_debt: 0 — that field was
-- already being cleared).
--
-- Reversible on purpose: the cleared text of 30 of those rows exists nowhere
-- else in the database (they left the report before 13/09/2026, when billing
-- started scraping Bllink itself, so bllink_scrape_rows cannot rebuild them),
-- so the values are copied out before the UPDATE and migrate:down restores
-- them exactly. Same idea as debtors.phone_owner_raw_backup.
--
-- ARCHIVED rows are out of scope, like everywhere else in the sync (Ronen's
-- decision 27/09/2026) — in production there are none anyway.
create table if not exists public.debtors_stale_import_text_backup (
  debtor_id        uuid primary key references public.debtors(id) on delete cascade,
  apartment_number text not null,
  details          text,
  monthly_debt     text,
  cleared_at       timestamptz not null default now()
);

comment on table public.debtors_stale_import_text_backup is
  'Pre-clearing snapshot of debtors.details / debtors.monthly_debt for apartments whose debt was fully settled (one-time cleanup 29/09/2026). Rollback source for migration 20260929043204; safe to drop once the cleanup is confirmed.';

insert into public.debtors_stale_import_text_backup (debtor_id, apartment_number, details, monthly_debt)
select id, apartment_number, details, monthly_debt
  from public.debtors
 where is_archived = false
   and coalesce(total_debt, 0) = 0
   and coalesce(management_fees, 0) = 0
   and coalesce(hot_water_debt, 0) = 0
   and (details is not null or monthly_debt is not null)
on conflict (debtor_id) do nothing;

-- Driven by the backup table, so exactly what was saved is what gets cleared.
update public.debtors d
   set details = null,
       monthly_debt = null
  from public.debtors_stale_import_text_backup b
 where b.debtor_id = d.id;

-- migrate:down
update public.debtors d
   set details = b.details,
       monthly_debt = b.monthly_debt
  from public.debtors_stale_import_text_backup b
 where b.debtor_id = d.id;

drop table public.debtors_stale_import_text_backup;
