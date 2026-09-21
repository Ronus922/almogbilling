-- migrate:up

-- debtor_id keeps meaning exactly what it always meant: a real debt record, or
-- null when there isn't one. It is NOT repurposed to sometimes hold a contacts.id
-- (that would leave the column meaning two different things with no way to tell
-- which). contact_id is a second, always-populated column so every recipient
-- stays linked to its apartment regardless of debt status.
alter table public.wa_campaign_recipients
  add column contact_id uuid;

-- Backfill from the existing debtor_id -> debtors.contact_id link. Verified
-- (20/09/2026) that all 759 existing rows have a debtor_id resolving to a
-- debtors row with a non-null contact_id — zero gaps, so this is a full
-- backfill, not a best-effort one.
update public.wa_campaign_recipients r
set contact_id = d.contact_id
from public.debtors d
where r.debtor_id = d.id
  and r.contact_id is null;

alter table public.wa_campaign_recipients
  alter column contact_id set not null;

-- RESTRICT (not debtors_contact_id_fkey's SET NULL): a sent campaign's history
-- must stay linked to the apartment it went to. Matches chips_contact_id_fkey's
-- convention for the same kind of immutable historical reference.
alter table public.wa_campaign_recipients
  add constraint wa_campaign_recipients_contact_id_fkey
  foreign key (contact_id) references public.contacts(id) on delete restrict;

create index wa_campaign_recipients_contact_id_idx
  on public.wa_campaign_recipients (contact_id);

-- migrate:down

drop index if exists public.wa_campaign_recipients_contact_id_idx;

alter table public.wa_campaign_recipients
  drop constraint wa_campaign_recipients_contact_id_fkey;

alter table public.wa_campaign_recipients
  drop column contact_id;
