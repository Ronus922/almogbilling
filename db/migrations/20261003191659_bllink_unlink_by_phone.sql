-- migrate:up
-- Bllink "ניתוק" decided by PHONE, not by name (approved 03/10/2026, before
-- the first scrape that reads the people).
--
-- A rehearsal on a production copy showed ~256 "ניתוק" suggestions, most of
-- them for people Bllink still lists — under another spelling, or with no
-- usable phone. The rule from now on, per link (phone) of an apartment the
-- list spoke about:
--   1. the phone (E.164) is listed ACTIVE in that apartment, in any name or
--      role → the person is there. Never "ניתוק". When the card's name differs
--      from Bllink's → a NAME suggestion only (the existing "תיקון שם" /
--      "החלפת בעלים" decision);
--   2. the phone is listed there only as isActive = false → "ניתוק",
--      reason 'inactive';
--   3. Bllink has a person there with NO usable phone and the link's name →
--      matched by name: the person is there (inactive → "ניתוק", 'inactive');
--   4. otherwise → "ניתוק", reason 'phone_not_listed'.
-- An open "ניתוק" the rule no longer supports is closed as obsolete, with a
-- row in audit_log — never deleted.
--
-- The scrape keeps every person of the list now, isActive = false included
-- ({"active": false}); a scrape from before reads as all-active.
--
-- Additive: one column + check, three new functions; bllink_scrape_people
-- keeps its shape (active people only); portal_link_suggest gains one output
-- column (suggested_name), so it is dropped and created — the down section
-- restores the previous one.

-- ── Why a "ניתוק" was suggested ─────────────────────────────────────────────
alter table public.contact_sync_suggestions
  add column unlink_reason text,
  add constraint contact_sync_suggestions_unlink_reason_check
    check (unlink_reason is null
           or (field = 'portal_unlink' and unlink_reason in ('phone_not_listed', 'inactive')));

comment on column public.contact_sync_suggestions.unlink_reason is
  'portal_unlink only: why — phone_not_listed (Bllink does not list the phone in that apartment) or inactive (listed with isActive = false). NULL on every other row and on unlinks raised before 20261003191659.';

-- ── Every person of the list, active or not ─────────────────────────────────
create or replace function public.bllink_scrape_persons(p_scrape_id uuid)
returns table (apartment_number text, role text, name text, phone_e164 text, active boolean)
language sql
stable
as $$
  select btrim(a.key),
         case p.value->>'role' when 'owner' then 'owner' else 'tenant' end,
         nullif(btrim(coalesce(p.value->>'name', '')), ''),
         public.portal_owner_e164(p.value->>'phone'),
         p.value->'active' is distinct from 'false'::jsonb
    from public.bllink_scrapes s
    cross join lateral jsonb_each(
      case when s.tenant_list_ok and jsonb_typeof(s.list_people) = 'object'
           then s.list_people else '{}'::jsonb end) a
    cross join lateral jsonb_array_elements(
      case jsonb_typeof(a.value) when 'array' then a.value else '[]'::jsonb end) p
   where s.id = p_scrape_id
     and p.value->>'role' in ('owner', 'tenant')
     and exists (select 1 from public.contacts c where c.apartment_number = btrim(a.key));
$$;

comment on function public.bllink_scrape_persons(uuid) is
  'Every person of one scrape''s resident list on an apartment we have, with isActive (a scrape from before 20261003191659 kept active people only — read as active).';

-- The ACTIVE people — what "שיוך" is proposed from. Same shape as before.
create or replace function public.bllink_scrape_people(p_scrape_id uuid)
returns table (apartment_number text, role text, name text, phone_e164 text)
language sql
stable
as $$
  select p.apartment_number, p.role, p.name, p.phone_e164
    from public.bllink_scrape_persons(p_scrape_id) p
   where p.active;
$$;

-- ── One verdict per active link of an apartment the list spoke about ────────
create or replace function public.bllink_link_verdict(p_scrape_id uuid)
returns table (link_id uuid, apartment_number text, phone_e164 text, role text,
               link_name text, verdict text, bllink_name text)
language sql
stable
as $$
  with ppl as (select * from public.bllink_scrape_persons(p_scrape_id)),
       apts as (select distinct apartment_number from public.bllink_scrape_apartments(p_scrape_id)),
       links as (
         select r.id, r.apartment_number, r.phone_e164, r.role, r.source_table, r.source_field,
                -- the link's name: the record's, live; the roster label when none
                coalesce(case r.source_table
                           when 'contacts' then (
                             select nullif(btrim(case r.source_field
                                                   when 'tenant_phone' then c.tenant_name
                                                   when 'operator_phone' then c.operator_name
                                                   else c.owner_name end), '')
                               from public.contacts c where c.id = r.source_row_id)
                           when 'contact_people' then (
                             select nullif(btrim(cp.name), '')
                               from public.contact_people cp where cp.id = r.source_row_id)
                         end,
                         nullif(btrim(r.owner_name), '')) as name
           from public.apartment_owner_phones r
          where r.is_active
            and r.apartment_number in (select apartment_number from apts))
  select l.id, l.apartment_number, l.phone_e164, l.role, l.name,
         case
           -- 1. by phone
           when bp.active then 'listed'
           when bp.phone_e164 is not null then 'inactive'
           -- 2. no phone to match: by name
           when bn.active then 'name_match'
           when bn.name is not null then 'inactive'
           else 'phone_not_listed'
         end,
         bp.name
    from links l
    left join lateral (
      select p.phone_e164, p.name, p.active
        from ppl p
       where p.apartment_number = l.apartment_number and p.phone_e164 = l.phone_e164
       order by p.active desc, (p.role = 'owner') desc, p.name nulls last
       limit 1) bp on true
    left join lateral (
      select p.name, p.active
        from ppl p
       where p.apartment_number = l.apartment_number
         and p.phone_e164 is null
         and l.name is not null
         and public.contact_value_norm('owner_name', p.name)
             = public.contact_value_norm('owner_name', l.name)
       order by p.active desc
       limit 1) bn on true;
$$;

comment on function public.bllink_link_verdict(uuid) is
  'Per active portal link of an apartment one scrape''s list spoke about: listed (phone active there, any name) / name_match (no usable phone in Bllink, same name) / inactive (isActive = false) / phone_not_listed. Matched by E.164 phone first, by name only when Bllink has no phone for the person.';

-- ── Close the "ניתוק" the rule no longer supports — logged ──────────────────
create or replace function public.portal_unlink_close(p_scrape_id uuid)
returns integer
language plpgsql
as $$
declare
  v_n integer;
begin
  with apts as (select distinct apartment_number from public.bllink_scrape_apartments(p_scrape_id)),
       v as (select * from public.bllink_link_verdict(p_scrape_id)),
       why as (
         select s.id,
                case when not exists (select 1 from public.apartment_owner_phones r
                                       where r.apartment_number = s.apartment_number
                                         and r.phone_e164 = s.phone_e164 and r.is_active)
                     then 'link_inactive'
                     else (select case v.verdict when 'listed' then 'bllink_lists_phone'
                                                 when 'name_match' then 'bllink_lists_name' end
                             from v
                            where v.apartment_number = s.apartment_number
                              and v.phone_e164 = s.phone_e164
                              and v.verdict in ('listed', 'name_match')
                            limit 1)
                end as reason
           from public.contact_sync_suggestions s
          where s.status = 'pending'
            and s.field = 'portal_unlink'
            and s.apartment_number in (select apartment_number from apts)),
       closed as (
         update public.contact_sync_suggestions s
            set status = 'obsolete', resolved_at = now()
           from why
          where s.id = why.id and why.reason is not null
         returning s.id, s.apartment_number, s.phone_e164, s.person_role, why.reason)
  insert into public.audit_log (actor_user_id, action, entity_type, entity_id, metadata)
  select null, 'contact_suggestion_closed', 'contact_sync_suggestion', c.id::text,
         jsonb_build_object('apartment_number', c.apartment_number, 'field', 'portal_unlink',
                            'phone_e164', c.phone_e164, 'role', c.person_role,
                            'reason', c.reason, 'scrape_id', p_scrape_id)
    from closed c;
  get diagnostics v_n = row_count;
  return v_n;
end;
$$;

comment on function public.portal_unlink_close(uuid) is
  'Closes (obsolete, never deletes) every open portal_unlink of the apartments one scrape''s list spoke about that the phone-first rule no longer supports — the link is gone, or Bllink lists the phone / the name — one audit_log row each (contact_suggestion_closed).';

-- ── The comparison, per person, by phone ────────────────────────────────────
drop function public.portal_link_suggest(uuid);

create function public.portal_link_suggest(p_scrape_id uuid)
returns table (suggested_link integer, suggested_unlink integer, suggested_name integer, closed integer)
language plpgsql
as $$
declare
  v_link integer := 0;
  v_unlink integer := 0;
  v_name integer := 0;
  v_closed integer := 0;
  v_n integer;
begin
  -- "שיוך" the facts settled on their own: the card now carries the phone,
  -- or Bllink stopped listing the person.
  with apts as (select apartment_number from public.bllink_scrape_apartments(p_scrape_id)),
       ppl  as (select * from public.bllink_scrape_people(p_scrape_id))
  update public.contact_sync_suggestions s
     set status = 'obsolete', resolved_at = now()
   where s.status = 'pending'
     and s.field = 'portal_link'
     and s.apartment_number in (select apartment_number from apts)
     and (exists (select 1 from public.portal_roster_desired(s.apartment_number) d
                   where d.phone_e164 = s.phone_e164)
          or not exists (select 1 from ppl p
                          where p.apartment_number = s.apartment_number and p.phone_e164 = s.phone_e164));
  get diagnostics v_n = row_count; v_closed := v_closed + v_n;

  -- "ניתוק" the phone-first rule no longer supports — logged.
  v_closed := v_closed + public.portal_unlink_close(p_scrape_id);

  -- A person Bllink lists whose phone the card does not carry in a portal
  -- role → "link?". Not when the same phone already waits as a field
  -- suggestion of that apartment, and not when it was turned down before.
  with ppl as (select * from public.bllink_scrape_people(p_scrape_id))
  insert into public.contact_sync_suggestions
    (apartment_number, field, current_value, proposed_value, source,
     phone_e164, person_role, person_name)
  select distinct on (p.apartment_number, p.phone_e164)
         p.apartment_number, 'portal_link', null, p.phone_e164, 'bllink',
         p.phone_e164, p.role, p.name
    from ppl p
   where p.phone_e164 is not null
     and not exists (select 1 from public.portal_roster_desired(p.apartment_number) d
                      where d.phone_e164 = p.phone_e164)
     and not exists (select 1 from public.contact_sync_suggestions f
                      where f.apartment_number = p.apartment_number
                        and f.status = 'pending'
                        and f.field in ('owner_phone', 'tenant_phone')
                        and public.portal_owner_e164(f.proposed_value) = p.phone_e164)
     and not exists (select 1 from public.contact_sync_suggestions r
                      where r.apartment_number = p.apartment_number
                        and r.field = 'portal_link'
                        and r.status = 'rejected'
                        and r.phone_e164 = p.phone_e164)
   order by p.apartment_number, p.phone_e164, (p.role = 'owner') desc
  on conflict (apartment_number, field, phone_e164) where status = 'pending' and phone_e164 is not null
  do nothing;
  get diagnostics v_link = row_count;

  -- An open "ניתוק" whose reason moved (gone ↔ inactive) says the new one.
  update public.contact_sync_suggestions s
     set unlink_reason = v.verdict
    from public.bllink_link_verdict(p_scrape_id) v
   where s.status = 'pending'
     and s.field = 'portal_unlink'
     and s.apartment_number = v.apartment_number
     and s.phone_e164 = v.phone_e164
     and v.verdict in ('phone_not_listed', 'inactive')
     and s.unlink_reason is distinct from v.verdict;

  -- "ניתוק" only when the phone is not listed there at all, or only as
  -- isActive = false — never because the name differs.
  insert into public.contact_sync_suggestions
    (apartment_number, field, current_value, proposed_value, source,
     phone_e164, person_role, person_name, unlink_reason)
  select v.apartment_number, 'portal_unlink', v.link_name, v.phone_e164, 'bllink',
         v.phone_e164, v.role, v.link_name, v.verdict
    from public.bllink_link_verdict(p_scrape_id) v
   where v.verdict in ('phone_not_listed', 'inactive')
     and not exists (select 1 from public.contact_sync_suggestions x
                      where x.apartment_number = v.apartment_number
                        and x.field = 'portal_unlink'
                        and x.status = 'rejected'
                        and x.phone_e164 = v.phone_e164)
  on conflict (apartment_number, field, phone_e164) where status = 'pending' and phone_e164 is not null
  do nothing;
  get diagnostics v_unlink = row_count;

  -- The phone is there under another name → a NAME suggestion for the card
  -- field that phone sits in (owner / tenant). Only when the card's name is
  -- nobody's in Bllink's list for that apartment (otherwise the phone, not the
  -- name, is what differs), nothing is open on that field yet (the ingest's
  -- own proposal stands), and the same name was not turned down before.
  with ppl as (select * from public.bllink_scrape_people(p_scrape_id)),
       cand as (
         select distinct on (c.apartment_number, f.field)
                c.apartment_number, f.field, f.card_name, v.bllink_name
           from public.bllink_link_verdict(p_scrape_id) v
           join public.apartment_owner_phones r on r.id = v.link_id
           join public.contacts c on c.id = r.source_row_id
           cross join lateral (
             select case r.source_field when 'owner_phone' then 'owner_name'
                                        when 'tenant_phone' then 'tenant_name' end as field,
                    case r.source_field when 'owner_phone' then c.owner_name
                                        when 'tenant_phone' then c.tenant_name end as card_name) f
          where v.verdict = 'listed'
            and r.source_table = 'contacts'
            and f.field is not null
            and v.bllink_name is not null
            and nullif(btrim(coalesce(f.card_name, '')), '') is not null
            and public.contact_value_norm('owner_name', f.card_name)
                <> public.contact_value_norm('owner_name', v.bllink_name)
            and not exists (select 1 from ppl p
                             where p.apartment_number = c.apartment_number
                               and public.contact_value_norm('owner_name', p.name)
                                   = public.contact_value_norm('owner_name', f.card_name))
            and not exists (select 1 from public.contact_sync_suggestions x
                             where x.apartment_number = c.apartment_number
                               and x.field = f.field
                               and x.status = 'rejected'
                               and public.contact_value_norm(x.field, x.proposed_value)
                                   = public.contact_value_norm(f.field, v.bllink_name))
          order by c.apartment_number, f.field, v.bllink_name)
  insert into public.contact_sync_suggestions
    (apartment_number, field, current_value, proposed_value, source)
  select apartment_number, field, card_name, bllink_name, 'bllink'
    from cand
  on conflict (apartment_number, field) where status = 'pending' and phone_e164 is null
  do nothing;
  get diagnostics v_name = row_count;

  suggested_link := v_link; suggested_unlink := v_unlink; suggested_name := v_name; closed := v_closed;
  return next;
end;
$$;

comment on function public.portal_link_suggest(uuid) is
  'Compare one scrape''s resident list with the portal links, matched by phone first: a listed person the card does not carry → portal_link; a linked phone Bllink does not list in that apartment, or lists only as inactive → portal_unlink (with unlink_reason); a phone listed under another name → a name suggestion for its card field. Suggests only — nothing is linked or unlinked here.';

-- Any open "ניתוק" raised by the name-blind rule, against the newest list we
-- hold — closed now, not at the next sync.
select public.portal_unlink_close(s.id)
  from (select id from public.bllink_scrapes
         where status = 'success' and tenant_list_ok and list_people is not null
         order by started_at desc limit 1) s;

-- migrate:down
drop function if exists public.portal_link_suggest(uuid);

create function public.portal_link_suggest(p_scrape_id uuid)
returns table (suggested_link integer, suggested_unlink integer, closed integer)
language plpgsql
as $$
declare
  v_link integer := 0;
  v_unlink integer := 0;
  v_closed integer := 0;
  v_n integer;
begin
  with apts as (select apartment_number from public.bllink_scrape_apartments(p_scrape_id)),
       ppl  as (select * from public.bllink_scrape_people(p_scrape_id))
  update public.contact_sync_suggestions s
     set status = 'obsolete', resolved_at = now()
   where s.status = 'pending'
     and s.field = 'portal_link'
     and s.apartment_number in (select apartment_number from apts)
     and (exists (select 1 from public.portal_roster_desired(s.apartment_number) d
                   where d.phone_e164 = s.phone_e164)
          or not exists (select 1 from ppl p
                          where p.apartment_number = s.apartment_number and p.phone_e164 = s.phone_e164));
  get diagnostics v_n = row_count; v_closed := v_closed + v_n;

  with apts as (select apartment_number from public.bllink_scrape_apartments(p_scrape_id)),
       ppl  as (select * from public.bllink_scrape_people(p_scrape_id))
  update public.contact_sync_suggestions s
     set status = 'obsolete', resolved_at = now()
   where s.status = 'pending'
     and s.field = 'portal_unlink'
     and s.apartment_number in (select apartment_number from apts)
     and (not exists (select 1 from public.apartment_owner_phones r
                       where r.apartment_number = s.apartment_number
                         and r.phone_e164 = s.phone_e164 and r.is_active)
          or exists (select 1 from ppl p
                      where p.apartment_number = s.apartment_number and p.phone_e164 = s.phone_e164));
  get diagnostics v_n = row_count; v_closed := v_closed + v_n;

  with ppl as (select * from public.bllink_scrape_people(p_scrape_id))
  insert into public.contact_sync_suggestions
    (apartment_number, field, current_value, proposed_value, source,
     phone_e164, person_role, person_name)
  select distinct on (p.apartment_number, p.phone_e164)
         p.apartment_number, 'portal_link', null, p.phone_e164, 'bllink',
         p.phone_e164, p.role, p.name
    from ppl p
   where p.phone_e164 is not null
     and not exists (select 1 from public.portal_roster_desired(p.apartment_number) d
                      where d.phone_e164 = p.phone_e164)
     and not exists (select 1 from public.contact_sync_suggestions f
                      where f.apartment_number = p.apartment_number
                        and f.status = 'pending'
                        and f.field in ('owner_phone', 'tenant_phone')
                        and public.portal_owner_e164(f.proposed_value) = p.phone_e164)
     and not exists (select 1 from public.contact_sync_suggestions r
                      where r.apartment_number = p.apartment_number
                        and r.field = 'portal_link'
                        and r.status = 'rejected'
                        and r.phone_e164 = p.phone_e164)
   order by p.apartment_number, p.phone_e164, (p.role = 'owner') desc
  on conflict (apartment_number, field, phone_e164) where status = 'pending' and phone_e164 is not null
  do nothing;
  get diagnostics v_link = row_count;

  with apts as (select apartment_number from public.bllink_scrape_apartments(p_scrape_id)),
       ppl  as (select * from public.bllink_scrape_people(p_scrape_id))
  insert into public.contact_sync_suggestions
    (apartment_number, field, current_value, proposed_value, source,
     phone_e164, person_role, person_name)
  select r.apartment_number, 'portal_unlink', r.owner_name, r.phone_e164, 'bllink',
         r.phone_e164, r.role, r.owner_name
    from public.apartment_owner_phones r
   where r.is_active
     and r.apartment_number in (select apartment_number from apts)
     and not exists (select 1 from ppl p
                      where p.apartment_number = r.apartment_number and p.phone_e164 = r.phone_e164)
     and not exists (select 1 from public.contact_sync_suggestions x
                      where x.apartment_number = r.apartment_number
                        and x.field = 'portal_unlink'
                        and x.status = 'rejected'
                        and x.phone_e164 = r.phone_e164)
  on conflict (apartment_number, field, phone_e164) where status = 'pending' and phone_e164 is not null
  do nothing;
  get diagnostics v_unlink = row_count;

  suggested_link := v_link; suggested_unlink := v_unlink; closed := v_closed;
  return next;
end;
$$;

comment on function public.portal_link_suggest(uuid) is
  'Compare one scrape''s resident list (bllink_scrapes.list_people) with the portal links: a linked phone Bllink no longer lists → portal_unlink suggestion; a listed person the card does not carry → portal_link suggestion. Suggests only — nothing is linked or unlinked here.';

drop function if exists public.portal_unlink_close(uuid);
drop function if exists public.bllink_link_verdict(uuid);

create or replace function public.bllink_scrape_people(p_scrape_id uuid)
returns table (apartment_number text, role text, name text, phone_e164 text)
language sql
stable
as $$
  select btrim(a.key),
         case p.value->>'role' when 'owner' then 'owner' else 'tenant' end,
         nullif(btrim(coalesce(p.value->>'name', '')), ''),
         public.portal_owner_e164(p.value->>'phone')
    from public.bllink_scrapes s
    cross join lateral jsonb_each(
      case when s.tenant_list_ok and jsonb_typeof(s.list_people) = 'object'
           then s.list_people else '{}'::jsonb end) a
    cross join lateral jsonb_array_elements(
      case jsonb_typeof(a.value) when 'array' then a.value else '[]'::jsonb end) p
   where s.id = p_scrape_id
     and p.value->>'role' in ('owner', 'tenant')
     and exists (select 1 from public.contacts c where c.apartment_number = btrim(a.key));
$$;

drop function if exists public.bllink_scrape_persons(uuid);

alter table public.contact_sync_suggestions
  drop constraint if exists contact_sync_suggestions_unlink_reason_check,
  drop column if exists unlink_reason;
