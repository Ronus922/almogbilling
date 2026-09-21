-- migrate:up

-- Blocks deleting a contact that has an active (non-archived) debtor. Today
-- debtors_contact_id_fkey (ON DELETE SET NULL) lets this happen silently,
-- orphaning the debt record and — since the contacts-first broadcast base
-- (20260921000521) — making that debtor invisible to every broadcast
-- audience too, with no error anywhere.
--
-- Deliberately does NOT block a contact whose only debtor is archived, or one
-- with no debtor at all: a plain FK's ON DELETE RESTRICT is unconditional and
-- can't express "only when active", so this needs a BEFORE DELETE trigger.
-- 251/290 contacts are already covered by wa_campaign_recipients_contact_id_
-- fkey's RESTRICT (broadcast history); this covers the other 39, of which 32
-- have an active debtor today (verified 21/09/2026) — the remaining 7 have
-- neither broadcast history nor an active debt and stay freely deletable.
--
-- Custom SQLSTATE 'BL001' (not a real PostgreSQL-reserved class) so the API
-- layer — and any script or manual query — can detect this specific block by
-- code, not by matching the Hebrew message text (which may be reworded later
-- without breaking that detection). Mirrored as a named constant in
-- src/lib/db/contacts.ts (ACTIVE_DEBT_DELETE_BLOCKED_SQLSTATE).
--
-- The message includes the apartment number directly from OLD, so whoever
-- runs a script against several apartments knows exactly which one was
-- blocked — and the API forwards this message verbatim rather than
-- re-deriving it, so the two can't drift apart.
create or replace function public.block_delete_contact_with_active_debt()
returns trigger
language plpgsql
as $$
begin
  if exists (
    select 1 from public.debtors d
    where d.contact_id = old.id and d.is_archived = false
  ) then
    raise exception 'לא ניתן למחוק — לדירה % קיים חוב פעיל', old.apartment_number
      using errcode = 'BL001';
  end if;
  return old;
end;
$$;

create trigger contacts_block_delete_with_active_debt
  before delete on public.contacts
  for each row
  execute function public.block_delete_contact_with_active_debt();

-- migrate:down

drop trigger if exists contacts_block_delete_with_active_debt on public.contacts;
drop function if exists public.block_delete_contact_with_active_debt();
