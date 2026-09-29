-- migrate:up
-- ONE source of truth for owner phones (bug 29/09/2026, apartment 1233).
--
-- What was wrong: public.apartment_owner_phones — the roster the portal's OTP
-- lookup reads — was filled ONCE, by the backfill of 27/09/2026, and never
-- again. "רשימת דיירים" writes contacts.owner_phone and contact_people, and the
-- Bllink sync writes contacts.owner_phone; NOTHING carried either of them into
-- the roster. So an owner added or corrected after 27/09 was told "המספר אינו
-- רשום" forever: נעמה אביגדור (+972523326988, apartment 1233) was entered by
-- hand on 29/09 08:05 UTC and could not sign in at 08:02–08:06.
--
-- The fix is a TRIGGER rather than a write in the data layer, on purpose: the
-- roster then follows contacts whatever writes them — the apartment card, the
-- Excel import, the Bllink sync, a future route, or a hand-written UPDATE. A
-- call site cannot forget what it never has to call.
--
-- Two rules the triggers deliberately do NOT break:
--   • ADDITIVE ONLY. A row is never deleted and never switched off here. An
--     owner who sold keeps their row until an admin switches it off on the
--     "בעלי דירה" tab — that is a deliberate act, and a nightly sync must not
--     be able to perform it by accident (and the login log of a past owner
--     stays readable, per the 27/09 decision).
--   • is_active IS NEVER TOUCHED, not even back to true. A phone an admin
--     switched off stays off until the same screen switches it on again; the
--     Bllink report re-supplying that number every morning must not undo it.

-- ── Deleting an apartment ───────────────────────────────────────────────────
-- The roster's FK was ON DELETE RESTRICT, which was harmless while the roster
-- held only the 284 apartments of the 27/09 backfill: the rest could still be
-- deleted. Once the triggers below give almost every apartment with an owner
-- mobile a roster row, RESTRICT would quietly turn "delete this apartment" into
-- a foreign-key error across the board. CASCADE is also what the data means —
-- a roster row keyed on an apartment that no longer exists grants access to
-- nothing. The login log is unaffected: portal_login_events keeps
-- apartment_numbers as a text[] SNAPSHOT, deliberately not an FK, exactly so
-- the history survives the roster (migration 20260927053126).
--
-- The real guard on deleting an apartment is untouched: the trigger
-- block_delete_contact_with_active_debt (errcode BL001) still refuses while a
-- live debt record exists.
alter table public.apartment_owner_phones
  drop constraint apartment_owner_phones_apartment_number_fkey,
  add constraint apartment_owner_phones_apartment_number_fkey
    foreign key (apartment_number) references public.contacts(apartment_number)
    on update cascade on delete cascade;

-- ── The rule, in SQL ────────────────────────────────────────────────────────
-- A FOURTH copy of the one phone rule, and the only one that can run inside a
-- trigger. It mirrors toPortalE164() (src/lib/portal/phone.ts) statement by
-- statement — including normalizePhone()'s own quirks: the "/,;|" split that
-- keeps the first number of a multi-number cell, the '00' international prefix,
-- the missing trunk 0, and the '+' branch that never injects 972.
-- tests/portal-owner-roster.test.ts feeds the SAME fixture list through both
-- and asserts they agree, so the two cannot drift apart in silence.
create or replace function public.portal_owner_e164(raw text)
returns text
language plpgsql
immutable
as $$
declare
  first_part text;
  digits     text;
begin
  if raw is null or btrim(raw) = '' then return null; end if;

  -- normalizePhone: a cell may hold several numbers — the first one wins.
  first_part := btrim(split_part(regexp_replace(raw, '[/,;|]', '/', 'g'), '/', 1));
  digits := regexp_replace(first_part, '\D', '', 'g');
  if digits = '' then return null; end if;

  -- A '+' with a non-Israeli country code is E.164 exactly as written.
  if left(first_part, 1) = '+' and left(digits, 3) <> '972' then
    if digits ~ '^[1-9][0-9]{6,14}$' then return '+' || digits; end if;
    return null;
  end if;

  if left(digits, 2) = '00' then digits := substr(digits, 3); end if;

  if left(digits, 3) = '972' then
    null;                                            -- already international
  elsif left(digits, 1) = '0' then
    digits := '972' || substr(digits, 2);            -- local trunk 0
  elsif length(digits) = 9 and digits ~ '^[2-9]' then
    digits := '972' || digits;                       -- subscriber, no trunk 0
  end if;

  if digits !~ '^972[0-9]{8,9}$' then return null; end if;

  -- Israel: a MOBILE only. 072/073/074/076/077 are ten digits exactly like a
  -- mobile, so this is a PREFIX test, never a length test.
  if digits ~ '^9725[0-9]{8}$' then return '+' || digits; end if;
  return null;
end;
$$;

comment on function public.portal_owner_e164(text) is
  'Owner phone -> E.164 roster key, or NULL. Mirrors toPortalE164() in src/lib/portal/phone.ts; pinned to it by tests/portal-owner-roster.test.ts.';

-- ── The upsert both triggers share ──────────────────────────────────────────
create or replace function public.portal_roster_upsert(
  p_apartment text,
  p_name      text,
  p_raw_phone text
) returns void
language plpgsql
as $$
declare
  e164 text := public.portal_owner_e164(p_raw_phone);
begin
  if e164 is null or p_apartment is null or btrim(p_apartment) = '' then return; end if;
  -- The apartment must exist: the roster's FK points at contacts, and a
  -- contact_people row can in principle outlive its contact mid-transaction.
  if not exists (select 1 from public.contacts c where c.apartment_number = p_apartment) then
    return;
  end if;

  insert into public.apartment_owner_phones (apartment_number, owner_name, phone_e164)
  values (p_apartment, nullif(btrim(coalesce(p_name, '')), ''), e164)
  on conflict (apartment_number, phone_e164) do update
    -- Refresh the display name only; is_active is the admin's, not the sync's.
    set owner_name = coalesce(
      nullif(btrim(coalesce(excluded.owner_name, '')), ''),
      public.apartment_owner_phones.owner_name
    );
end;
$$;

-- ── contacts.owner_phone → roster ───────────────────────────────────────────
create or replace function public.portal_roster_from_contact()
returns trigger
language plpgsql
as $$
begin
  perform public.portal_roster_upsert(new.apartment_number, new.owner_name, new.owner_phone);
  return null;
end;
$$;

create trigger portal_roster_from_contact_aiu
  after insert or update of owner_phone, owner_name, apartment_number
  on public.contacts
  for each row
  execute function public.portal_roster_from_contact();

-- ── contact_people (role = 'owner') → roster ────────────────────────────────
-- The additional owners of an apartment. DELETE is deliberately NOT a trigger
-- event: removing someone from the card must not silently revoke portal access
-- (see the additive-only rule above).
create or replace function public.portal_roster_from_contact_person()
returns trigger
language plpgsql
as $$
declare
  apt text;
begin
  if new.role is distinct from 'owner' then return null; end if;
  select c.apartment_number into apt from public.contacts c where c.id = new.contact_id;
  perform public.portal_roster_upsert(apt, new.name, new.phone);
  return null;
end;
$$;

create trigger portal_roster_from_contact_person_aiu
  after insert or update of phone, name, role, contact_id
  on public.contact_people
  for each row
  execute function public.portal_roster_from_contact_person();

-- ── One-time backfill ───────────────────────────────────────────────────────
-- Every owner who already had a phone in the residents list but no roster row.
-- On 29/09/2026 this is exactly 2 rows, both apartment 1233 (נעמה אביגדור
-- +972523326988 and מיכה אביגדור +972509123201) — the only apartment edited
-- since the 27/09 backfill. Written as a set operation so it is correct
-- whatever the data holds when it actually runs.
insert into public.apartment_owner_phones (apartment_number, owner_name, phone_e164)
select apartment_number, owner_name, e164
from (
  select c.apartment_number,
         nullif(btrim(coalesce(c.owner_name, '')), '') as owner_name,
         public.portal_owner_e164(c.owner_phone)       as e164
    from public.contacts c
  union
  select c.apartment_number,
         nullif(btrim(coalesce(p.name, '')), ''),
         public.portal_owner_e164(p.phone)
    from public.contact_people p
    join public.contacts c on c.id = p.contact_id
   where p.role = 'owner'
) s
where e164 is not null
on conflict (apartment_number, phone_e164) do nothing;

-- migrate:down
alter table public.apartment_owner_phones
  drop constraint apartment_owner_phones_apartment_number_fkey,
  add constraint apartment_owner_phones_apartment_number_fkey
    foreign key (apartment_number) references public.contacts(apartment_number)
    on update cascade on delete restrict;

drop trigger if exists portal_roster_from_contact_person_aiu on public.contact_people;
drop trigger if exists portal_roster_from_contact_aiu on public.contacts;
drop function if exists public.portal_roster_from_contact_person();
drop function if exists public.portal_roster_from_contact();
drop function if exists public.portal_roster_upsert(text, text, text);
drop function if exists public.portal_owner_e164(text);
-- The backfilled rows are deliberately KEPT: they are real owners, and
-- removing them would lock people out again. Deactivate them on the
-- "בעלי דירה" tab if that is ever actually wanted.
