-- migrate:up
-- An EXTRA owner is never unlinked because Bllink does not list them (approved
-- 03/10/2026, before the first scrape that reads the people).
--
-- Bllink does not hold every contact of an owner: the extra owners of a card
-- (contact_people, role owner) are mostly people Bllink never knew. A
-- rehearsal on a production copy gave 242 "ניתוק", 229 of them extra owners
-- whose phone is simply absent from the list. Absence is not evidence
-- that someone left, so, per link of an apartment the list spoke about:
--   - an extra owner whose phone (or, phoneless, name) Bllink does not list →
--     verdict 'extra_owner_not_listed': no "ניתוק". Removing an extra owner is
--     done by hand, on the apartment card;
--   - an extra owner Bllink lists with isActive = false → "ניתוק", 'inactive'
--     (explicit evidence) — unchanged;
--   - the owner FIELD, tenants and operators (extra ones included) — unchanged:
--     "ניתוק" when the phone is not listed, or listed only as inactive.
-- An open "ניתוק" of an extra owner the list does not mention is closed by the
-- sync like any other the rule no longer supports (obsolete + audit_log,
-- reason extra_owner_not_listed). This migration changes no data.
--
-- Additive: both functions keep their signature (create or replace); the down
-- section restores 20261003191659's bodies.

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
           -- 3. not listed: an extra owner's absence proves nothing
           when l.role = 'owner' and l.source_table = 'contact_people' then 'extra_owner_not_listed'
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
  'Per active portal link of an apartment one scrape''s list spoke about: listed (phone active there, any name) / name_match (no usable phone in Bllink, same name) / inactive (isActive = false) / extra_owner_not_listed (an extra owner — contact_people — Bllink does not list: no evidence, never "ניתוק") / phone_not_listed. Matched by E.164 phone first, by name only when Bllink has no phone for the person.';

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
                                                 when 'name_match' then 'bllink_lists_name'
                                                 when 'extra_owner_not_listed' then 'extra_owner_not_listed' end
                             from v
                            where v.apartment_number = s.apartment_number
                              and v.phone_e164 = s.phone_e164
                              and v.verdict in ('listed', 'name_match', 'extra_owner_not_listed')
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
  'Closes (obsolete, never deletes) every open portal_unlink of the apartments one scrape''s list spoke about that the rule no longer supports — the link is gone, Bllink lists the phone / the name, or it is an extra owner the list does not mention — one audit_log row each (contact_suggestion_closed).';

-- migrate:down
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
           when bp.active then 'listed'
           when bp.phone_e164 is not null then 'inactive'
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
