-- migrate:up
-- The owners portal opens by ROLE (approved 03/10/2026, "פורטל לפי תפקיד").
--
-- Until now only an owner record opened the portal (20261003095149). From here
-- three roles do — owner, tenant, operator — each through the apartment's own
-- records, and the role is kept on the link:
--
--   owner    ← contacts.owner_phone            · contact_people role 'owner'
--   operator ← contacts.operator_phone
--            ← contacts.tenant_phone           · contact_people role 'tenant'
--              when the card's resident type is 'operator' (the card labels
--              that section "פרטי המפעיל")
--   tenant   ← contacts.tenant_phone           · contact_people role 'tenant'
--              when the card's resident type is 'tenant'
--
-- The tenant/operator section of the card is shown ONLY when the resident type
-- is not 'owner' (contact-form-panel.tsx). A phone sitting in a hidden tenant
-- field — 118 apartments carry one, most filled from Bllink while the card says
-- the owner lives there — is not something staff can see on the card, so it
-- opens nothing: a person is "registered in the apartment" when the card shows
-- them. Bllink's resident list proposes such people through the queue instead
-- (migration 20261003161749_bllink_people_suggestions).
--
-- A broker, a "בטיפול של" carer, anyone else: there is no role for them, so no
-- access. They are recorded today under the owner role by hand; those rows were
-- detached on 03/10/2026 and stay detached until the record is fixed.
--
-- Every rule of 20261003095149 carries over unchanged — deferred sync at
-- COMMIT, both directions, sticky detach, E.164, provenance, audit_log — with
-- ONE refinement: a detach holds for the ROLE it was made in. When the record
-- changes the phone's role (the fix for an owner field that held a tenant's
-- phone is to move it to the tenant field), the detach is released and the
-- phone links afresh in its new role. That is how the detaches of 03/10/2026
-- "stay until Ronen fixes the role in the record" and lapse when he does.
--
-- One phone, one row per apartment (the UNIQUE of the table is unchanged): a
-- phone found in two roles of the same apartment links once, in the widest
-- role — owner before operator before tenant.
--
-- Additive: two new columns with their checks; the desired-set function is
-- recreated with two more output columns; the sync and one trigger function
-- are replaced (the down section restores both); the contacts trigger is
-- recreated over more columns. The closing backfill runs the sync once per
-- apartment, which LINKS the tenants and operators the cards already show —
-- every link in audit_log, like any other.

-- ── Role and the field that carries it ──────────────────────────────────────
alter table public.apartment_owner_phones
  add column role text not null default 'owner',
  add column source_field text;

-- Every row so far came from an owner record.
update public.apartment_owner_phones
   set source_field = 'owner_phone'
 where source_table = 'contacts';

alter table public.apartment_owner_phones
  add constraint apartment_owner_phones_role_check
    check (role in ('owner', 'tenant', 'operator')),
  add constraint apartment_owner_phones_source_field_check
    check (source_field is null or source_field in ('owner_phone', 'tenant_phone', 'operator_phone')),
  add constraint apartment_owner_phones_source_field_shape_check
    check ((source_table is not distinct from 'contacts') = (source_field is not null));

comment on column public.apartment_owner_phones.role is
  'The role the phone holds in the apartment: owner · tenant · operator. The widest wins when one phone holds several (owner > operator > tenant). Written by portal_roster_sync only. owner_name holds the name of whoever carries the phone, whatever the role.';
comment on column public.apartment_owner_phones.source_field is
  'For source_table = contacts: which field carries the phone (owner_phone · tenant_phone · operator_phone). NULL for contact_people.';

-- ── What the records of one apartment say ───────────────────────────────────
-- One row per phone: the record that carries it, its name and its role. Order
-- of precedence: the owner field, extra owners (card order), the operator
-- field, the tenant/operator field, extra tenants/operators (card order).
drop function public.portal_roster_desired(text);
create function public.portal_roster_desired(p_apartment text)
returns table (phone_e164 text, source_table text, source_row_id uuid, owner_name text,
               role text, source_field text)
language sql
stable
as $$
  select distinct on (s.e164) s.e164, s.st, s.sid, s.nm, s.rl, s.sf
    from (
      select public.portal_owner_e164(c.owner_phone)          as e164,
             'contacts'::text                                  as st,
             c.id                                              as sid,
             nullif(btrim(coalesce(c.owner_name, '')), '')     as nm,
             'owner'::text                                     as rl,
             'owner_phone'::text                               as sf,
             0 as pri, 0 as so, c.created_at as ca
        from public.contacts c
       where c.apartment_number = p_apartment
      union all
      select public.portal_owner_e164(p.phone), 'contact_people', p.id,
             nullif(btrim(coalesce(p.name, '')), ''),
             'owner', null::text,
             1, p.sort_order, p.created_at
        from public.contact_people p
        join public.contacts c on c.id = p.contact_id
       where c.apartment_number = p_apartment
         and p.role = 'owner'
      union all
      select public.portal_owner_e164(c.operator_phone), 'contacts', c.id,
             nullif(btrim(coalesce(c.operator_name, '')), ''),
             'operator', 'operator_phone',
             2, 0, c.created_at
        from public.contacts c
       where c.apartment_number = p_apartment
      union all
      select public.portal_owner_e164(c.tenant_phone), 'contacts', c.id,
             nullif(btrim(coalesce(c.tenant_name, '')), ''),
             case c.resident_type when 'operator' then 'operator' else 'tenant' end,
             'tenant_phone',
             3, 0, c.created_at
        from public.contacts c
       where c.apartment_number = p_apartment
         and c.resident_type in ('tenant', 'operator')
      union all
      select public.portal_owner_e164(p.phone), 'contact_people', p.id,
             nullif(btrim(coalesce(p.name, '')), ''),
             case c.resident_type when 'operator' then 'operator' else 'tenant' end,
             null::text,
             4, p.sort_order, p.created_at
        from public.contact_people p
        join public.contacts c on c.id = p.contact_id
       where c.apartment_number = p_apartment
         and p.role = 'tenant'
         and c.resident_type in ('tenant', 'operator')
    ) s
   where s.e164 is not null
   order by s.e164, s.pri, s.so, s.ca, s.sid;
$$;

comment on function public.portal_roster_desired(text) is
  'The roster an apartment SHOULD have: one row per E.164 phone found in its records in a portal role (owner field / extra owners / operator field / the tenant-or-operator section when the card shows it), with the record, the name and the role.';

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

  -- 1. An ACTIVE phone no record carries any more → off.
  with gone as (
    update public.apartment_owner_phones r
       set is_active = false, source_table = null, source_row_id = null, source_field = null
     where r.apartment_number = p_apartment
       and r.is_active
       and not exists (select 1 from public.portal_roster_desired(p_apartment) d
                        where d.phone_e164 = r.phone_e164)
    returning r.id, r.phone_e164, r.owner_name, r.role
  )
  insert into public.audit_log (action, entity_type, entity_id, metadata)
  select 'portal_owner_phone_deactivated', 'apartment_owner_phone', g.id::text,
         jsonb_build_object('apartment_number', p_apartment, 'phone_e164', g.phone_e164,
                            'owner_name', g.owner_name, 'role', g.role,
                            'reason', 'source_removed', 'via', 'portal_roster_sync')
    from gone g;

  -- 2. A DETACHED phone is released when it left every record of the
  --    apartment, or when the records now give it a DIFFERENT role (a detach
  --    holds for the role it was made in). The row stays off here; a phone the
  --    records still carry links afresh in step 4.
  with released as (
    update public.apartment_owner_phones r
       set detached_at = null, detached_by = null, detach_reason = null,
           source_table = null, source_row_id = null, source_field = null
      from (select r2.id,
                   (select d.role from public.portal_roster_desired(p_apartment) d
                     where d.phone_e164 = r2.phone_e164) as new_role
              from public.apartment_owner_phones r2
             where r2.apartment_number = p_apartment
               and r2.detached_at is not null) x
     where r.id = x.id
       and (x.new_role is null or x.new_role <> r.role)
    returning r.id, r.phone_e164, r.owner_name, r.role, x.new_role
  )
  insert into public.audit_log (action, entity_type, entity_id, metadata)
  select 'portal_owner_phone_detach_released', 'apartment_owner_phone', l.id::text,
         jsonb_build_object('apartment_number', p_apartment, 'phone_e164', l.phone_e164,
                            'owner_name', l.owner_name, 'role', l.role,
                            'reason', case when l.new_role is null then 'source_removed' else 'role_changed' end,
                            'new_role', l.new_role, 'via', 'portal_roster_sync')
    from released l;

  -- An inactive row no record carries keeps no stale pointer.
  update public.apartment_owner_phones r
     set source_table = null, source_row_id = null, source_field = null
   where r.apartment_number = p_apartment
     and not r.is_active
     and r.source_table is not null
     and not exists (select 1 from public.portal_roster_desired(p_apartment) d
                      where d.phone_e164 = r.phone_e164);

  -- 3. A phone the records carry and the roster has never seen → linked.
  with ins as (
    insert into public.apartment_owner_phones
      (apartment_number, owner_name, phone_e164, source_table, source_row_id, role, source_field)
    select p_apartment, d.owner_name, d.phone_e164, d.source_table, d.source_row_id, d.role, d.source_field
      from public.portal_roster_desired(p_apartment) d
     where not exists (select 1 from public.apartment_owner_phones r
                        where r.apartment_number = p_apartment and r.phone_e164 = d.phone_e164)
    on conflict (apartment_number, phone_e164) do nothing
    returning id, phone_e164, owner_name, source_table, source_row_id, role
  )
  insert into public.audit_log (action, entity_type, entity_id, metadata)
  select 'portal_owner_phone_linked', 'apartment_owner_phone', i.id::text,
         jsonb_build_object('apartment_number', p_apartment, 'phone_e164', i.phone_e164,
                            'owner_name', i.owner_name, 'role', i.role,
                            'source_table', i.source_table,
                            'source_row_id', i.source_row_id, 'via', 'portal_roster_sync')
    from ins i;

  -- 4. An inactive, NOT detached row whose phone a record carries again → on,
  --    in the role the records give it now.
  with back as (
    update public.apartment_owner_phones r
       set is_active = true, owner_name = d.owner_name, role = d.role,
           source_table = d.source_table, source_row_id = d.source_row_id,
           source_field = d.source_field
      from public.portal_roster_desired(p_apartment) d
     where r.apartment_number = p_apartment
       and r.phone_e164 = d.phone_e164
       and not r.is_active
       and r.detached_at is null
    returning r.id, r.phone_e164, r.owner_name, r.role, r.source_table, r.source_row_id
  )
  insert into public.audit_log (action, entity_type, entity_id, metadata)
  select 'portal_owner_phone_relinked', 'apartment_owner_phone', b.id::text,
         jsonb_build_object('apartment_number', p_apartment, 'phone_e164', b.phone_e164,
                            'owner_name', b.owner_name, 'role', b.role,
                            'source_table', b.source_table,
                            'source_row_id', b.source_row_id, 'via', 'portal_roster_sync')
    from back b;

  -- 5. Active rows follow their record: the name, the role, where it lives.
  --    A name change and a role change are logged — the name decides whether a
  --    multi-apartment phone is one person (lib/portal/identity.ts), the role
  --    what the phone sees. The record's id alone changes on every card save
  --    (contact_people is rewritten), so that is not logged.
  with cur as (
    select r.id, r.phone_e164, r.owner_name as old_name, d.owner_name as new_name,
           r.role as old_role, d.role as new_role,
           d.source_table, d.source_row_id, d.source_field
      from public.apartment_owner_phones r
      join public.portal_roster_desired(p_apartment) d on d.phone_e164 = r.phone_e164
     where r.apartment_number = p_apartment
       and r.is_active
       and (r.owner_name is distinct from d.owner_name
            or r.role is distinct from d.role
            or r.source_table is distinct from d.source_table
            or r.source_row_id is distinct from d.source_row_id
            or r.source_field is distinct from d.source_field)
  ), upd as (
    update public.apartment_owner_phones r
       set owner_name = cur.new_name, role = cur.new_role,
           source_table = cur.source_table, source_row_id = cur.source_row_id,
           source_field = cur.source_field
      from cur
     where r.id = cur.id
    returning r.id
  ), renamed as (
    insert into public.audit_log (action, entity_type, entity_id, metadata)
    select 'portal_owner_phone_renamed', 'apartment_owner_phone', cur.id::text,
           jsonb_build_object('apartment_number', p_apartment, 'phone_e164', cur.phone_e164,
                              'from', cur.old_name, 'to', cur.new_name, 'via', 'portal_roster_sync')
      from cur
      join upd on upd.id = cur.id
     where cur.old_name is distinct from cur.new_name
    returning 1
  )
  insert into public.audit_log (action, entity_type, entity_id, metadata)
  select 'portal_owner_phone_role_changed', 'apartment_owner_phone', cur.id::text,
         jsonb_build_object('apartment_number', p_apartment, 'phone_e164', cur.phone_e164,
                            'owner_name', cur.new_name,
                            'from', cur.old_role, 'to', cur.new_role, 'via', 'portal_roster_sync')
    from cur
    join upd on upd.id = cur.id
   where cur.old_role is distinct from cur.new_role;

  -- 6. A detached row a record still carries (in the same role — step 2
  --    released the others): only the pointer follows, so the admin screen can
  --    show WHICH record still holds the phone.
  update public.apartment_owner_phones r
     set source_table = d.source_table, source_row_id = d.source_row_id,
         source_field = d.source_field
    from public.portal_roster_desired(p_apartment) d
   where r.apartment_number = p_apartment
     and r.phone_e164 = d.phone_e164
     and r.detached_at is not null
     and (r.source_table is distinct from d.source_table
          or r.source_row_id is distinct from d.source_row_id
          or r.source_field is distinct from d.source_field);
end;
$$;

comment on function public.portal_roster_sync(text) is
  'Recompute one apartment''s portal roster from its records in the three portal roles, both directions, every link change logged in audit_log. Runs from the deferred triggers portal_roster_sync_*; never re-links a detached row in the role it was detached in.';

-- ── The triggers: every role, every field that decides one ──────────────────
create or replace function public.portal_roster_sync_from_contact_person()
returns trigger
language plpgsql
as $$
declare
  apt text;
begin
  if tg_op in ('UPDATE', 'DELETE') then
    select c.apartment_number into apt from public.contacts c where c.id = old.contact_id;
    perform public.portal_roster_sync(apt);
  end if;
  if tg_op in ('INSERT', 'UPDATE') then
    select c.apartment_number into apt from public.contacts c where c.id = new.contact_id;
    perform public.portal_roster_sync(apt);
  end if;
  return null;
end;
$$;

drop trigger portal_roster_sync_contact_aiu on public.contacts;
create constraint trigger portal_roster_sync_contact_aiu
  after insert or update of owner_phone, owner_name, tenant_phone, tenant_name,
                            operator_phone, operator_name, resident_type, apartment_number
  on public.contacts
  deferrable initially deferred
  for each row
  execute function public.portal_roster_sync_from_contact();

-- ── Backfill: every apartment once, logged like any other sync ──────────────
select public.portal_roster_sync(c.apartment_number) from public.contacts c;

-- migrate:down
-- The owner-only mirror of 20261003095149 back. Tenant and operator rows the
-- sync linked are switched OFF (logged) — the owner-only rule has no place for
-- them — and the role columns go. Owner rows are untouched.
drop trigger portal_roster_sync_contact_aiu on public.contacts;
create constraint trigger portal_roster_sync_contact_aiu
  after insert or update of owner_phone, owner_name, apartment_number
  on public.contacts
  deferrable initially deferred
  for each row
  execute function public.portal_roster_sync_from_contact();

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

with off as (
  update public.apartment_owner_phones r
     set is_active = false, detached_at = null, detached_by = null, detach_reason = null,
         source_table = null, source_row_id = null, source_field = null
   where r.role <> 'owner'
  returning r.id, r.apartment_number, r.phone_e164, r.owner_name, r.role
)
insert into public.audit_log (action, entity_type, entity_id, metadata)
select 'portal_owner_phone_deactivated', 'apartment_owner_phone', o.id::text,
       jsonb_build_object('apartment_number', o.apartment_number, 'phone_e164', o.phone_e164,
                          'owner_name', o.owner_name, 'role', o.role,
                          'reason', 'roles_migration_down', 'via', 'migration')
  from off o;

drop function public.portal_roster_desired(text);
create function public.portal_roster_desired(p_apartment text)
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

create or replace function public.portal_roster_sync(p_apartment text)
returns void
language plpgsql
as $$
begin
  if p_apartment is null
     or not exists (select 1 from public.contacts c where c.apartment_number = p_apartment) then
    return;
  end if;

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

  update public.apartment_owner_phones r
     set source_table = null, source_row_id = null
   where r.apartment_number = p_apartment
     and not r.is_active
     and r.source_table is not null
     and not exists (select 1 from public.portal_roster_desired(p_apartment) d
                      where d.phone_e164 = r.phone_e164);

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

alter table public.apartment_owner_phones
  drop constraint if exists apartment_owner_phones_source_field_shape_check,
  drop constraint if exists apartment_owner_phones_source_field_check,
  drop constraint if exists apartment_owner_phones_role_check,
  drop column if exists source_field,
  drop column if exists role;
