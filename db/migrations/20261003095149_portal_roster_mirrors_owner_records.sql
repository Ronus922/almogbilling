-- migrate:up
-- The portal roster MIRRORS the owner records (phase C, approved 03/10/2026).
--
-- The audit of 03/10/2026 (reports/portal-mapping-audit-2026-10-03.md, local
-- only) found three ways a phone ended up on an apartment it does not own:
--   1. the triggers of 20260929162740 were ADD-ONLY — a phone removed from the
--      card, or replaced, kept its roster row for ever (40 such rows);
--   2. approving a Bllink suggestion wrote owner_name BEFORE owner_phone, so the
--      PREVIOUS owner's phone was relabelled with the NEW owner's name and kept
--      its access;
--   3. brokers / tenants / operators typed into the owner fields (a data issue,
--      fixed by hand — this migration does not touch contacts or contact_people).
--
-- The iron rule from here on: a phone is linked to an apartment ONLY through an
-- explicit owner record of THAT apartment that carries the phone —
-- contacts.owner_phone, or a contact_people row with role 'owner'. No inference
-- from names, no partial match, never a tenant.
--
-- What changes:
--   • provenance: every row says which record carries it (source_table +
--     source_row_id);
--   • a deliberate DETACH (admin, the approved clean-up, an owner replaced on a
--     Bllink approval) is recorded on the row and is STICKY: the sync never
--     re-links a detached row while the record still holds that phone. The
--     detach is released only when the phone leaves every owner record of the
--     apartment — and a phone typed in again after that links again. That is
--     the one way back ("through the owner record only"); there is no manual
--     add any more;
--   • portal_roster_sync(apartment) recomputes ONE apartment from its owner
--     records, in both directions, and logs every link change in audit_log;
--   • it runs from DEFERRED constraint triggers, i.e. at COMMIT of the very
--     transaction that changed the records: the apartment card's
--     delete-all + insert-all of contact_people is judged on its FINAL state,
--     not on the empty list in between;
--   • the two add-only triggers are DISABLED (not dropped — the down section
--     re-enables them);
--   • contact_suggestion_resolve writes the owner's name and phone in ONE
--     statement, and an approved owner REPLACEMENT detaches the previous
--     owner's phones in the same call;
--   • portal_owner_e164 trims every whitespace JavaScript's trim() does
--     (NBSP, tab, …) — the one gap the audit found against toPortalE164().
--
-- is_active stays THE validity flag every reader checks (isActiveOwner,
-- findOwnerIdentity, the account, the reporter): a detached row is simply
-- is_active = false with a recorded reason, so no reader changes.
--
-- Additive: new columns, new constraints, new functions, new triggers. The old
-- triggers are disabled, not dropped; the replaced function bodies are restored
-- by the down section. No row is deactivated HERE: the approved clean-up is a
-- logged data step of its own (scripts/portal/roster-detach.mjs), run after
-- this migration.

-- ── Provenance and detach ───────────────────────────────────────────────────
alter table public.apartment_owner_phones
  add column source_table  text,
  add column source_row_id uuid,
  add column detached_at   timestamptz,
  add column detached_by   uuid references public.users(id) on delete set null,
  add column detach_reason text,
  add constraint apartment_owner_phones_source_table_check
    check (source_table is null or source_table in ('contacts', 'contact_people')),
  add constraint apartment_owner_phones_source_pair_check
    check ((source_table is null) = (source_row_id is null)),
  add constraint apartment_owner_phones_detach_shape_check
    check ((detached_at is null) = (detach_reason is null)),
  add constraint apartment_owner_phones_detached_inactive_check
    check (detached_at is null or not is_active);

comment on column public.apartment_owner_phones.source_table is
  'Which owner record carries this phone today: contacts (owner_phone) or contact_people (role owner). NULL = no record holds it (an inactive row). Written by portal_roster_sync only.';
comment on column public.apartment_owner_phones.source_row_id is
  'contacts.id or contact_people.id of that record. Not an FK: the apartment card deletes and re-inserts contact_people on every save, and the sync repoints this at commit.';
comment on column public.apartment_owner_phones.detached_at is
  'A deliberate detach (admin / approved clean-up / owner replaced). Sticky: the sync does not re-link while the owner record still holds the phone; released when the phone leaves every owner record of the apartment.';
comment on column public.apartment_owner_phones.detach_reason is
  'Why it was detached: admin · audit_2026_10 · owner_replaced (free text, the audit_log entry carries the detail).';

-- ── The phone rule, whitespace-exact ────────────────────────────────────────
-- Same algorithm as 20260929162740, one change: the trims strip every
-- character String.prototype.trim() strips, not only the ASCII space. A cell
-- starting with an NBSP before '+44…' was rejected here and accepted by
-- toPortalE164() — a missing row, never a wrong one, but still a divergence.
create or replace function public.portal_owner_e164(raw text)
returns text
language plpgsql
immutable
as $$
declare
  ws constant text := '[\s   -     　﻿]';
  first_part text;
  digits     text;
begin
  if raw is null or regexp_replace(raw, '^' || ws || '+|' || ws || '+$', '', 'g') = '' then
    return null;
  end if;

  -- normalizePhone: a cell may hold several numbers — the first one wins.
  first_part := regexp_replace(
    split_part(regexp_replace(raw, '[/,;|]', '/', 'g'), '/', 1),
    '^' || ws || '+|' || ws || '+$', '', 'g');
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

  -- Israel: a MOBILE only (a PREFIX test — VoIP is ten digits too).
  if digits ~ '^9725[0-9]{8}$' then return '+' || digits; end if;
  return null;
end;
$$;

-- ── What the owner records of one apartment say ─────────────────────────────
-- One row per phone. The name is the name ON THE RECORD THAT CARRIES THE PHONE
-- — never the apartment's owner name for a phone some other record holds.
-- contacts.owner_phone wins over a contact_people row with the same phone;
-- among contact_people the card's order (sort_order), then age, then id.
create or replace function public.portal_roster_desired(p_apartment text)
returns table (phone_e164 text, source_table text, source_row_id uuid, owner_name text)
language sql
stable
as $$
  select distinct on (s.e164) s.e164, s.st, s.sid, s.nm
    from (
      select public.portal_owner_e164(c.owner_phone)          as e164,
             'contacts'::text                                  as st,
             c.id                                              as sid,
             nullif(btrim(coalesce(c.owner_name, '')), '')     as nm,
             0 as pri, 0 as so, c.created_at as ca
        from public.contacts c
       where c.apartment_number = p_apartment
      union all
      select public.portal_owner_e164(p.phone),
             'contact_people',
             p.id,
             nullif(btrim(coalesce(p.name, '')), ''),
             1, p.sort_order, p.created_at
        from public.contact_people p
        join public.contacts c on c.id = p.contact_id
       where c.apartment_number = p_apartment
         and p.role = 'owner'
    ) s
   where s.e164 is not null
   order by s.e164, s.pri, s.so, s.ca, s.sid;
$$;

comment on function public.portal_roster_desired(text) is
  'The roster an apartment SHOULD have: one row per E.164 phone found in its owner records (contacts.owner_phone, contact_people role owner), with the record that carries it.';

-- ── Recompute one apartment, both directions, logged ────────────────────────
create or replace function public.portal_roster_sync(p_apartment text)
returns void
language plpgsql
as $$
begin
  if p_apartment is null
     or not exists (select 1 from public.contacts c where c.apartment_number = p_apartment) then
    return;
  end if;

  -- 1. An ACTIVE phone no owner record carries any more → off.
  with gone as (
    update public.apartment_owner_phones r
       set is_active = false, source_table = null, source_row_id = null
     where r.apartment_number = p_apartment
       and r.is_active
       and not exists (select 1 from public.portal_roster_desired(p_apartment) d
                        where d.phone_e164 = r.phone_e164)
    returning r.id, r.phone_e164, r.owner_name
  )
  insert into public.audit_log (action, entity_type, entity_id, metadata)
  select 'portal_owner_phone_deactivated', 'apartment_owner_phone', g.id::text,
         jsonb_build_object('apartment_number', p_apartment, 'phone_e164', g.phone_e164,
                            'owner_name', g.owner_name, 'reason', 'source_removed',
                            'via', 'portal_roster_sync')
    from gone g;

  -- 2. A DETACHED phone that left every owner record: the detach is released
  --    (the row stays off). Typing the phone in again links it afresh.
  with released as (
    update public.apartment_owner_phones r
       set detached_at = null, detached_by = null, detach_reason = null,
           source_table = null, source_row_id = null
     where r.apartment_number = p_apartment
       and r.detached_at is not null
       and not exists (select 1 from public.portal_roster_desired(p_apartment) d
                        where d.phone_e164 = r.phone_e164)
    returning r.id, r.phone_e164, r.owner_name
  )
  insert into public.audit_log (action, entity_type, entity_id, metadata)
  select 'portal_owner_phone_detach_released', 'apartment_owner_phone', l.id::text,
         jsonb_build_object('apartment_number', p_apartment, 'phone_e164', l.phone_e164,
                            'owner_name', l.owner_name, 'reason', 'source_removed',
                            'via', 'portal_roster_sync')
    from released l;

  -- An inactive row no record carries keeps no stale pointer.
  update public.apartment_owner_phones r
     set source_table = null, source_row_id = null
   where r.apartment_number = p_apartment
     and not r.is_active
     and r.source_table is not null
     and not exists (select 1 from public.portal_roster_desired(p_apartment) d
                      where d.phone_e164 = r.phone_e164);

  -- 3. A phone the records carry and the roster has never seen → linked.
  with ins as (
    insert into public.apartment_owner_phones
      (apartment_number, owner_name, phone_e164, source_table, source_row_id)
    select p_apartment, d.owner_name, d.phone_e164, d.source_table, d.source_row_id
      from public.portal_roster_desired(p_apartment) d
     where not exists (select 1 from public.apartment_owner_phones r
                        where r.apartment_number = p_apartment and r.phone_e164 = d.phone_e164)
    on conflict (apartment_number, phone_e164) do nothing
    returning id, phone_e164, owner_name, source_table, source_row_id
  )
  insert into public.audit_log (action, entity_type, entity_id, metadata)
  select 'portal_owner_phone_linked', 'apartment_owner_phone', i.id::text,
         jsonb_build_object('apartment_number', p_apartment, 'phone_e164', i.phone_e164,
                            'owner_name', i.owner_name, 'source_table', i.source_table,
                            'source_row_id', i.source_row_id, 'via', 'portal_roster_sync')
    from ins i;

  -- 4. An inactive, NOT detached row whose phone a record carries again → on.
  with back as (
    update public.apartment_owner_phones r
       set is_active = true, owner_name = d.owner_name,
           source_table = d.source_table, source_row_id = d.source_row_id
      from public.portal_roster_desired(p_apartment) d
     where r.apartment_number = p_apartment
       and r.phone_e164 = d.phone_e164
       and not r.is_active
       and r.detached_at is null
    returning r.id, r.phone_e164, r.owner_name, r.source_table, r.source_row_id
  )
  insert into public.audit_log (action, entity_type, entity_id, metadata)
  select 'portal_owner_phone_relinked', 'apartment_owner_phone', b.id::text,
         jsonb_build_object('apartment_number', p_apartment, 'phone_e164', b.phone_e164,
                            'owner_name', b.owner_name, 'source_table', b.source_table,
                            'source_row_id', b.source_row_id, 'via', 'portal_roster_sync')
    from back b;

  -- 5. Active rows follow their record: the name on it, and where it lives.
  --    A name change is logged — it decides whether a multi-apartment phone is
  --    one person (lib/portal/ownership.ts). The record's id alone changes on
  --    every card save (contact_people is rewritten), so that is not logged.
  with cur as (
    select r.id, r.phone_e164, r.owner_name as old_name, d.owner_name as new_name,
           d.source_table, d.source_row_id
      from public.apartment_owner_phones r
      join public.portal_roster_desired(p_apartment) d on d.phone_e164 = r.phone_e164
     where r.apartment_number = p_apartment
       and r.is_active
       and (r.owner_name is distinct from d.owner_name
            or r.source_table is distinct from d.source_table
            or r.source_row_id is distinct from d.source_row_id)
  ), upd as (
    update public.apartment_owner_phones r
       set owner_name = cur.new_name,
           source_table = cur.source_table, source_row_id = cur.source_row_id
      from cur
     where r.id = cur.id
    returning r.id
  )
  insert into public.audit_log (action, entity_type, entity_id, metadata)
  select 'portal_owner_phone_renamed', 'apartment_owner_phone', cur.id::text,
         jsonb_build_object('apartment_number', p_apartment, 'phone_e164', cur.phone_e164,
                            'from', cur.old_name, 'to', cur.new_name, 'via', 'portal_roster_sync')
    from cur
    join upd on upd.id = cur.id
   where cur.old_name is distinct from cur.new_name;

  -- 6. A detached row a record still carries: only the pointer follows, so the
  --    admin screen can show WHICH record still holds the phone.
  update public.apartment_owner_phones r
     set source_table = d.source_table, source_row_id = d.source_row_id
    from public.portal_roster_desired(p_apartment) d
   where r.apartment_number = p_apartment
     and r.phone_e164 = d.phone_e164
     and r.detached_at is not null
     and (r.source_table is distinct from d.source_table
          or r.source_row_id is distinct from d.source_row_id);
end;
$$;

comment on function public.portal_roster_sync(text) is
  'Recompute one apartment''s portal roster from its owner records, both directions, every link change logged in audit_log. Runs from the deferred triggers portal_roster_sync_*; never re-links a detached row.';

-- ── The deferred triggers ───────────────────────────────────────────────────
create or replace function public.portal_roster_sync_from_contact()
returns trigger
language plpgsql
as $$
begin
  -- DELETE is not an event here: the roster's FK cascades with the apartment.
  perform public.portal_roster_sync(new.apartment_number);
  return null;
end;
$$;

create or replace function public.portal_roster_sync_from_contact_person()
returns trigger
language plpgsql
as $$
declare
  apt text;
begin
  if tg_op in ('UPDATE', 'DELETE') and old.role = 'owner' then
    select c.apartment_number into apt from public.contacts c where c.id = old.contact_id;
    perform public.portal_roster_sync(apt);
  end if;
  if tg_op in ('INSERT', 'UPDATE') and new.role = 'owner' then
    select c.apartment_number into apt from public.contacts c where c.id = new.contact_id;
    perform public.portal_roster_sync(apt);
  end if;
  return null;
end;
$$;

create constraint trigger portal_roster_sync_contact_aiu
  after insert or update of owner_phone, owner_name, apartment_number
  on public.contacts
  deferrable initially deferred
  for each row
  execute function public.portal_roster_sync_from_contact();

create constraint trigger portal_roster_sync_contact_person_aiud
  after insert or update of phone, name, role, contact_id or delete
  on public.contact_people
  deferrable initially deferred
  for each row
  execute function public.portal_roster_sync_from_contact_person();

-- The add-only pair is replaced by the mirror above. Disabled, not dropped.
alter table public.contacts disable trigger portal_roster_from_contact_aiu;
alter table public.contact_people disable trigger portal_roster_from_contact_person_aiu;

-- ── Bllink approval: name and phone together; owner replaced = detach ───────
create or replace function public.contact_suggestion_resolve(p_ids uuid[], p_action text, p_actor uuid)
returns integer
language plpgsql
as $$
declare
  v_now timestamptz := clock_timestamp();
  v_n integer;
begin
  if p_action not in ('approve', 'reject') then
    raise exception 'contact_suggestion_resolve: unknown action %', p_action;
  end if;

  -- Mark BEFORE writing the value: the provenance trigger closes any pending
  -- suggestion the new value satisfies, and it must not race this one into
  -- 'obsolete' while we are approving it. v_now identifies exactly the rows
  -- this call resolved.
  update public.contact_sync_suggestions
     set status = case when p_action = 'approve' then 'approved' else 'rejected' end,
         resolved_at = v_now,
         resolved_by = p_actor
   where id = any(p_ids) and status = 'pending';
  get diagnostics v_n = row_count;

  if p_action = 'approve' and v_n > 0 then
    -- The value is Bllink's; the decision was a person's. Provenance records
    -- where the value came from.
    perform set_config('app.write_source', 'bllink', true);

    -- An approved owner NAME that differs from a non-empty current one is an
    -- owner REPLACEMENT. The previous owner's phones in that apartment — the
    -- phone the owner field held, and every roster phone recorded under the
    -- previous owner's name — are detached now, in this call, unless the same
    -- approval names that phone as the new owner's. Without this, the old
    -- phone stays in owner_phone under the NEW name and keeps its access.
    with repl as (
      select c.apartment_number,
             c.owner_name                                  as old_name,
             public.portal_owner_e164(c.owner_phone)       as old_phone,
             public.portal_owner_e164(sp.proposed_value)   as new_phone
        from public.contact_sync_suggestions sn
        join public.contacts c on c.apartment_number = sn.apartment_number
        left join public.contact_sync_suggestions sp
               on sp.apartment_number = sn.apartment_number
              and sp.id = any(p_ids) and sp.resolved_at = v_now and sp.field = 'owner_phone'
       where sn.id = any(p_ids) and sn.resolved_at = v_now and sn.field = 'owner_name'
         and nullif(btrim(coalesce(c.owner_name, '')), '') is not null
         and public.contact_value_norm('owner_name', c.owner_name)
             is distinct from public.contact_value_norm('owner_name', sn.proposed_value)
    ), det as (
      update public.apartment_owner_phones r
         set is_active = false, detached_at = v_now, detached_by = p_actor,
             detach_reason = 'owner_replaced'
        from repl
       where r.apartment_number = repl.apartment_number
         and r.detached_at is null
         and (r.phone_e164 = repl.old_phone
              or public.contact_value_norm('owner_name', r.owner_name)
                 = public.contact_value_norm('owner_name', repl.old_name))
         and r.phone_e164 is distinct from repl.new_phone
      returning r.id, r.apartment_number, r.phone_e164, r.owner_name
    )
    insert into public.audit_log (actor_user_id, action, entity_type, entity_id, metadata)
    select p_actor, 'portal_owner_phone_detached', 'apartment_owner_phone', det.id::text,
           jsonb_build_object('apartment_number', det.apartment_number,
                              'phone_e164', det.phone_e164, 'owner_name', det.owner_name,
                              'reason', 'owner_replaced', 'via', 'contact_suggestion_resolve')
      from det;

    -- The owner's name and phone in ONE statement: never a moment where the
    -- new name sits on the previous owner's phone.
    update public.contacts c
       set owner_name  = coalesce(sn.proposed_value, c.owner_name),
           owner_phone = coalesce(sp.proposed_value, c.owner_phone)
      from (select distinct s.apartment_number
              from public.contact_sync_suggestions s
             where s.id = any(p_ids) and s.resolved_at = v_now
               and s.field in ('owner_name', 'owner_phone')) a
      left join public.contact_sync_suggestions sn
             on sn.apartment_number = a.apartment_number
            and sn.id = any(p_ids) and sn.resolved_at = v_now and sn.field = 'owner_name'
      left join public.contact_sync_suggestions sp
             on sp.apartment_number = a.apartment_number
            and sp.id = any(p_ids) and sp.resolved_at = v_now and sp.field = 'owner_phone'
     where c.apartment_number = a.apartment_number;

    update public.contacts c set owner_email = s.proposed_value
      from public.contact_sync_suggestions s
     where s.id = any(p_ids) and s.resolved_at = v_now and s.field = 'owner_email'
       and c.apartment_number = s.apartment_number;

    update public.contacts c set tenant_name = s.proposed_value
      from public.contact_sync_suggestions s
     where s.id = any(p_ids) and s.resolved_at = v_now and s.field = 'tenant_name'
       and c.apartment_number = s.apartment_number;

    update public.contacts c set tenant_phone = s.proposed_value
      from public.contact_sync_suggestions s
     where s.id = any(p_ids) and s.resolved_at = v_now and s.field = 'tenant_phone'
       and c.apartment_number = s.apartment_number;

    update public.contacts c set tenant_email = s.proposed_value
      from public.contact_sync_suggestions s
     where s.id = any(p_ids) and s.resolved_at = v_now and s.field = 'tenant_email'
       and c.apartment_number = s.apartment_number;

    perform set_config('app.write_source', '', true);
  end if;

  return v_n;
end;
$$;

-- ── Provenance for the rows that exist today ────────────────────────────────
-- Fills the two NEW columns only: no row is switched on or off here. A row no
-- record carries keeps NULL — those are the clean-up's to deactivate, logged.
update public.apartment_owner_phones r
   set source_table = d.source_table, source_row_id = d.source_row_id
  from public.contacts c,
       lateral public.portal_roster_desired(c.apartment_number) d
 where c.apartment_number = r.apartment_number
   and d.phone_e164 = r.phone_e164;

-- migrate:down
-- The mirror off, the add-only pair back on. Rows switched off by the sync or
-- by a detach stay off: switching them back on would re-open what was closed.
alter table public.contact_people enable trigger portal_roster_from_contact_person_aiu;
alter table public.contacts enable trigger portal_roster_from_contact_aiu;

drop trigger if exists portal_roster_sync_contact_person_aiud on public.contact_people;
drop trigger if exists portal_roster_sync_contact_aiu on public.contacts;
drop function if exists public.portal_roster_sync_from_contact_person();
drop function if exists public.portal_roster_sync_from_contact();
drop function if exists public.portal_roster_sync(text);
drop function if exists public.portal_roster_desired(text);

create or replace function public.contact_suggestion_resolve(p_ids uuid[], p_action text, p_actor uuid)
returns integer
language plpgsql
as $$
declare
  v_now timestamptz := clock_timestamp();
  v_n integer;
begin
  if p_action not in ('approve', 'reject') then
    raise exception 'contact_suggestion_resolve: unknown action %', p_action;
  end if;

  update public.contact_sync_suggestions
     set status = case when p_action = 'approve' then 'approved' else 'rejected' end,
         resolved_at = v_now,
         resolved_by = p_actor
   where id = any(p_ids) and status = 'pending';
  get diagnostics v_n = row_count;

  if p_action = 'approve' and v_n > 0 then
    perform set_config('app.write_source', 'bllink', true);

    update public.contacts c set owner_name = s.proposed_value
      from public.contact_sync_suggestions s
     where s.id = any(p_ids) and s.resolved_at = v_now and s.field = 'owner_name'
       and c.apartment_number = s.apartment_number;

    update public.contacts c set owner_phone = s.proposed_value
      from public.contact_sync_suggestions s
     where s.id = any(p_ids) and s.resolved_at = v_now and s.field = 'owner_phone'
       and c.apartment_number = s.apartment_number;

    update public.contacts c set owner_email = s.proposed_value
      from public.contact_sync_suggestions s
     where s.id = any(p_ids) and s.resolved_at = v_now and s.field = 'owner_email'
       and c.apartment_number = s.apartment_number;

    update public.contacts c set tenant_name = s.proposed_value
      from public.contact_sync_suggestions s
     where s.id = any(p_ids) and s.resolved_at = v_now and s.field = 'tenant_name'
       and c.apartment_number = s.apartment_number;

    update public.contacts c set tenant_phone = s.proposed_value
      from public.contact_sync_suggestions s
     where s.id = any(p_ids) and s.resolved_at = v_now and s.field = 'tenant_phone'
       and c.apartment_number = s.apartment_number;

    update public.contacts c set tenant_email = s.proposed_value
      from public.contact_sync_suggestions s
     where s.id = any(p_ids) and s.resolved_at = v_now and s.field = 'tenant_email'
       and c.apartment_number = s.apartment_number;

    perform set_config('app.write_source', '', true);
  end if;

  return v_n;
end;
$$;

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

  first_part := btrim(split_part(regexp_replace(raw, '[/,;|]', '/', 'g'), '/', 1));
  digits := regexp_replace(first_part, '\D', '', 'g');
  if digits = '' then return null; end if;

  if left(first_part, 1) = '+' and left(digits, 3) <> '972' then
    if digits ~ '^[1-9][0-9]{6,14}$' then return '+' || digits; end if;
    return null;
  end if;

  if left(digits, 2) = '00' then digits := substr(digits, 3); end if;

  if left(digits, 3) = '972' then
    null;
  elsif left(digits, 1) = '0' then
    digits := '972' || substr(digits, 2);
  elsif length(digits) = 9 and digits ~ '^[2-9]' then
    digits := '972' || digits;
  end if;

  if digits !~ '^972[0-9]{8,9}$' then return null; end if;

  if digits ~ '^9725[0-9]{8}$' then return '+' || digits; end if;
  return null;
end;
$$;

alter table public.apartment_owner_phones
  drop constraint if exists apartment_owner_phones_detached_inactive_check,
  drop constraint if exists apartment_owner_phones_detach_shape_check,
  drop constraint if exists apartment_owner_phones_source_pair_check,
  drop constraint if exists apartment_owner_phones_source_table_check,
  drop column if exists detach_reason,
  drop column if exists detached_by,
  drop column if exists detached_at,
  drop column if exists source_row_id,
  drop column if exists source_table;
