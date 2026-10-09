--
-- PostgreSQL database dump
--


SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SELECT pg_catalog.set_config('search_path', '', false);
SET check_function_bodies = false;
SET xmloption = content;
SET client_min_messages = warning;
SET row_security = off;

--
-- Name: public; Type: SCHEMA; Schema: -; Owner: -
--

CREATE SCHEMA public;


--
-- Name: SCHEMA public; Type: COMMENT; Schema: -; Owner: -
--

COMMENT ON SCHEMA public IS 'standard public schema';


--
-- Name: bllink_link_verdict(uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.bllink_link_verdict(p_scrape_id uuid) RETURNS TABLE(link_id uuid, apartment_number text, phone_e164 text, role text, link_name text, verdict text, bllink_name text)
    LANGUAGE sql STABLE
    AS $$
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


--
-- Name: FUNCTION bllink_link_verdict(p_scrape_id uuid); Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON FUNCTION public.bllink_link_verdict(p_scrape_id uuid) IS 'Per active portal link of an apartment one scrape''s list spoke about: listed (phone active there, any name) / name_match (no usable phone in Bllink, same name) / inactive (isActive = false) / extra_owner_not_listed (an extra owner — contact_people — Bllink does not list: no evidence, never "ניתוק") / phone_not_listed. Matched by E.164 phone first, by name only when Bllink has no phone for the person.';


--
-- Name: bllink_scrape_apartments(uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.bllink_scrape_apartments(p_scrape_id uuid) RETURNS TABLE(apartment_number text)
    LANGUAGE sql STABLE
    AS $$
  select distinct btrim(a.key)
    from public.bllink_scrapes s
    cross join lateral jsonb_each(
      case when s.tenant_list_ok and jsonb_typeof(s.list_people) = 'object'
           then s.list_people else '{}'::jsonb end) a
   where s.id = p_scrape_id
     and exists (select 1 from public.contacts c where c.apartment_number = btrim(a.key));
$$;


--
-- Name: bllink_scrape_people(uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.bllink_scrape_people(p_scrape_id uuid) RETURNS TABLE(apartment_number text, role text, name text, phone_e164 text)
    LANGUAGE sql STABLE
    AS $$
  select p.apartment_number, p.role, p.name, p.phone_e164
    from public.bllink_scrape_persons(p_scrape_id) p
   where p.active;
$$;


--
-- Name: bllink_scrape_persons(uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.bllink_scrape_persons(p_scrape_id uuid) RETURNS TABLE(apartment_number text, role text, name text, phone_e164 text, active boolean)
    LANGUAGE sql STABLE
    AS $$
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


--
-- Name: FUNCTION bllink_scrape_persons(p_scrape_id uuid); Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON FUNCTION public.bllink_scrape_persons(p_scrape_id uuid) IS 'Every person of one scrape''s resident list on an apartment we have, with isActive (a scrape from before 20261003191659 kept active people only — read as active).';


--
-- Name: block_delete_contact_with_active_debt(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.block_delete_contact_with_active_debt() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
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


--
-- Name: contact_owner_replacement_targets(text, text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.contact_owner_replacement_targets(p_apartment text, p_new_phone text) RETURNS TABLE(id uuid, phone_e164 text, owner_name text)
    LANGUAGE sql STABLE
    AS $$
  select r.id, r.phone_e164, r.owner_name
    from public.contacts c
    join public.apartment_owner_phones r on r.apartment_number = c.apartment_number
   where c.apartment_number = p_apartment
     and nullif(btrim(coalesce(c.owner_name, '')), '') is not null
     and r.is_active
     and r.role = 'owner'
     and (r.phone_e164 = public.portal_owner_e164(c.owner_phone)
          or public.contact_value_norm('owner_name', r.owner_name)
             = public.contact_value_norm('owner_name', c.owner_name))
     and r.phone_e164 is distinct from public.portal_owner_e164(p_new_phone)
   order by r.phone_e164;
$$;


--
-- Name: contact_suggestion_resolve(uuid[], text, uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.contact_suggestion_resolve(p_ids uuid[], p_action text, p_actor uuid) RETURNS integer
    LANGUAGE plpgsql
    AS $$
declare
  v_now timestamptz := clock_timestamp();
  v_n integer;
  v_mode text;
  v_bulk boolean;
  v_ids uuid[] := p_ids;
  v_link record;
  v_contact public.contacts%rowtype;
  v_role text;
begin
  if p_action not in ('approve', 'reject', 'approve_rename', 'approve_replace') then
    raise exception 'contact_suggestion_resolve: unknown action %', p_action;
  end if;
  v_mode := case p_action when 'approve_rename' then 'rename'
                          when 'approve_replace' then 'replace' end;
  v_bulk := p_action = 'approve' and cardinality(p_ids) > 1;

  -- A replacement brings the new owner's phone along (one decision).
  if v_mode = 'replace' then
    v_ids := v_ids || array(
      select sp.id
        from public.contact_sync_suggestions sn
        join public.contact_sync_suggestions sp
          on sp.apartment_number = sn.apartment_number
         and sp.field = 'owner_phone' and sp.status = 'pending'
       where sn.id = any(p_ids) and sn.field = 'owner_name' and sn.status = 'pending');
  end if;

  -- Mark BEFORE writing the value (the provenance trigger must not race this
  -- one into 'obsolete'). v_now identifies exactly the rows this call resolved.
  update public.contact_sync_suggestions s
     set status = case when p_action = 'reject' then 'rejected' else 'approved' end,
         resolved_at = v_now,
         resolved_by = p_actor
    from public.contacts c
   where s.id = any(v_ids) and s.status = 'pending'
     and c.apartment_number = s.apartment_number
     and (p_action = 'reject'
          or (-- the two owner-name decisions apply to an owner-name change
              -- (and a replacement to its new phone) only
              (v_mode is null
               or s.field = 'owner_name'
               or (v_mode = 'replace' and s.field = 'owner_phone'))
              -- an owner-name CHANGE needs one of the two decisions
              and (v_mode is not null
                   or not (s.field = 'owner_name'
                           and nullif(btrim(coalesce(c.owner_name, '')), '') is not null
                           and public.contact_value_norm('owner_name', c.owner_name)
                               is distinct from public.contact_value_norm('owner_name', s.proposed_value)))
              -- "אשר הכל" never changes portal access
              and not (v_bulk and s.field in ('owner_phone', 'tenant_phone', 'portal_link', 'portal_unlink'))
              -- an owner phone waits for its apartment's owner-name decision
              and not (s.field = 'owner_phone'
                       and exists (select 1 from public.contact_sync_suggestions n
                                    where n.apartment_number = s.apartment_number
                                      and n.field = 'owner_name' and n.status = 'pending'
                                      and not (v_mode = 'replace' and n.id = any(p_ids))
                                      and nullif(btrim(coalesce(c.owner_name, '')), '') is not null
                                      and public.contact_value_norm('owner_name', c.owner_name)
                                          is distinct from public.contact_value_norm('owner_name', n.proposed_value)))));
  get diagnostics v_n = row_count;

  if p_action <> 'reject' and v_n > 0 then
    perform set_config('app.write_source', 'bllink', true);

    -- An owner REPLACEMENT: the previous owner's phones are detached now, in
    -- this call — exactly contact_owner_replacement_targets(). A name FIX
    -- detaches nothing.
    if v_mode = 'replace' then
      with repl as (
        select sn.apartment_number, sp.proposed_value as new_phone
          from public.contact_sync_suggestions sn
          left join public.contact_sync_suggestions sp
                 on sp.apartment_number = sn.apartment_number
                and sp.id = any(v_ids) and sp.resolved_at = v_now and sp.field = 'owner_phone'
         where sn.id = any(v_ids) and sn.resolved_at = v_now and sn.field = 'owner_name'
      ), det as (
        update public.apartment_owner_phones r
           set is_active = false, detached_at = v_now, detached_by = p_actor,
               detach_reason = 'owner_replaced'
          from repl
         where r.id in (select t.id from public.contact_owner_replacement_targets(repl.apartment_number, repl.new_phone) t)
        returning r.id, r.apartment_number, r.phone_e164, r.owner_name
      )
      insert into public.audit_log (actor_user_id, action, entity_type, entity_id, metadata)
      select p_actor, 'portal_owner_phone_detached', 'apartment_owner_phone', det.id::text,
             jsonb_build_object('apartment_number', det.apartment_number,
                                'phone_e164', det.phone_e164, 'owner_name', det.owner_name,
                                'reason', 'owner_replaced', 'via', 'contact_suggestion_resolve')
        from det;
    end if;

    -- The owner-name decision itself, in audit_log: which of the two it was.
    insert into public.audit_log (actor_user_id, action, entity_type, entity_id, metadata)
    select p_actor, 'contact_owner_name_approved', 'contact_sync_suggestion', s.id::text,
           jsonb_build_object('apartment_number', s.apartment_number,
                              'from', s.current_value, 'to', s.proposed_value,
                              'mode', coalesce(v_mode, 'fill'))
      from public.contact_sync_suggestions s
     where s.id = any(v_ids) and s.resolved_at = v_now and s.field = 'owner_name';

    -- The owner's name and phone in ONE statement.
    update public.contacts c
       set owner_name  = coalesce(sn.proposed_value, c.owner_name),
           owner_phone = coalesce(sp.proposed_value, c.owner_phone)
      from (select distinct s.apartment_number
              from public.contact_sync_suggestions s
             where s.id = any(v_ids) and s.resolved_at = v_now
               and s.field in ('owner_name', 'owner_phone')) a
      left join public.contact_sync_suggestions sn
             on sn.apartment_number = a.apartment_number
            and sn.id = any(v_ids) and sn.resolved_at = v_now and sn.field = 'owner_name'
      left join public.contact_sync_suggestions sp
             on sp.apartment_number = a.apartment_number
            and sp.id = any(v_ids) and sp.resolved_at = v_now and sp.field = 'owner_phone'
     where c.apartment_number = a.apartment_number;

    update public.contacts c set owner_email = s.proposed_value
      from public.contact_sync_suggestions s
     where s.id = any(v_ids) and s.resolved_at = v_now and s.field = 'owner_email'
       and c.apartment_number = s.apartment_number;

    update public.contacts c set tenant_name = s.proposed_value
      from public.contact_sync_suggestions s
     where s.id = any(v_ids) and s.resolved_at = v_now and s.field = 'tenant_name'
       and c.apartment_number = s.apartment_number;

    update public.contacts c set tenant_phone = s.proposed_value
      from public.contact_sync_suggestions s
     where s.id = any(v_ids) and s.resolved_at = v_now and s.field = 'tenant_phone'
       and c.apartment_number = s.apartment_number;

    update public.contacts c set tenant_email = s.proposed_value
      from public.contact_sync_suggestions s
     where s.id = any(v_ids) and s.resolved_at = v_now and s.field = 'tenant_email'
       and c.apartment_number = s.apartment_number;

    -- "Unlink?" approved → the link is detached, like an admin detach (sticky
    -- while the card still carries the phone; the card is fixed by hand).
    with det as (
      update public.apartment_owner_phones r
         set is_active = false, detached_at = v_now, detached_by = p_actor,
             detach_reason = 'bllink_removed'
        from public.contact_sync_suggestions s
       where s.id = any(v_ids) and s.resolved_at = v_now and s.field = 'portal_unlink'
         and r.apartment_number = s.apartment_number
         and r.phone_e164 = s.phone_e164
         and r.is_active
      returning r.id, r.apartment_number, r.phone_e164, r.owner_name, r.role
    )
    insert into public.audit_log (actor_user_id, action, entity_type, entity_id, metadata)
    select p_actor, 'portal_owner_phone_detached', 'apartment_owner_phone', det.id::text,
           jsonb_build_object('apartment_number', det.apartment_number,
                              'phone_e164', det.phone_e164, 'owner_name', det.owner_name,
                              'role', det.role, 'reason', 'bllink_removed',
                              'via', 'contact_suggestion_resolve')
      from det;

    -- "Link?" approved → the person is written onto the CARD (the only way a
    -- phone links — the roster follows at commit): into the role's own field
    -- when it is free (or already holds this person's name), otherwise as an
    -- additional person of that role. A tenant on an apartment whose card says
    -- the owner lives there turns the card to 'tenant', so the person is shown.
    for v_link in
      select s.id, s.apartment_number, s.phone_e164, s.person_role, s.person_name
        from public.contact_sync_suggestions s
       where s.id = any(v_ids) and s.resolved_at = v_now and s.field = 'portal_link'
       order by s.apartment_number, s.phone_e164
    loop
      select * into v_contact from public.contacts c where c.apartment_number = v_link.apartment_number;
      v_role := case when v_link.person_role = 'owner' then 'owner' else 'tenant' end;

      if v_role = 'owner' then
        if public.portal_owner_e164(v_contact.owner_phone) is null
           and (nullif(btrim(coalesce(v_contact.owner_name, '')), '') is null
                or public.contact_value_norm('owner_name', v_contact.owner_name)
                   = public.contact_value_norm('owner_name', v_link.person_name)) then
          update public.contacts
             set owner_phone = v_link.phone_e164,
                 owner_name = coalesce(nullif(btrim(coalesce(owner_name, '')), ''), v_link.person_name)
           where id = v_contact.id;
        else
          insert into public.contact_people (contact_id, role, name, phone, sort_order)
          select v_contact.id, 'owner', v_link.person_name, v_link.phone_e164,
                 coalesce(max(p.sort_order), -1) + 1
            from public.contact_people p where p.contact_id = v_contact.id;
        end if;
      else
        if v_contact.resident_type = 'owner' then
          update public.contacts set resident_type = 'tenant' where id = v_contact.id;
        end if;
        if public.portal_owner_e164(v_contact.tenant_phone) = v_link.phone_e164 then
          null;  -- already on the card, it was only hidden
        elsif public.portal_owner_e164(v_contact.tenant_phone) is null
              and (nullif(btrim(coalesce(v_contact.tenant_name, '')), '') is null
                   or public.contact_value_norm('tenant_name', v_contact.tenant_name)
                      = public.contact_value_norm('tenant_name', v_link.person_name)) then
          update public.contacts
             set tenant_phone = v_link.phone_e164,
                 tenant_name = coalesce(nullif(btrim(coalesce(tenant_name, '')), ''), v_link.person_name)
           where id = v_contact.id;
        else
          insert into public.contact_people (contact_id, role, name, phone, sort_order)
          select v_contact.id, 'tenant', v_link.person_name, v_link.phone_e164,
                 coalesce(max(p.sort_order), -1) + 1
            from public.contact_people p where p.contact_id = v_contact.id;
        end if;
      end if;

      insert into public.audit_log (actor_user_id, action, entity_type, entity_id, metadata)
      values (p_actor, 'portal_link_approved', 'contact_sync_suggestion', v_link.id::text,
              jsonb_build_object('apartment_number', v_link.apartment_number,
                                 'phone_e164', v_link.phone_e164, 'role', v_link.person_role,
                                 'name', v_link.person_name,
                                 'resident_type_was', v_contact.resident_type,
                                 'via', 'contact_suggestion_resolve'));
    end loop;

    perform set_config('app.write_source', '', true);
  end if;

  return v_n;
end;
$$;


--
-- Name: contact_sync_incoming(text[], text[], text[], boolean[]); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.contact_sync_incoming(p_apartments text[], p_fields text[], p_values text[], p_may_suggest boolean[] DEFAULT NULL::boolean[]) RETURNS TABLE(apartment_number text, field text, value text, may_suggest boolean)
    LANGUAGE sql IMMUTABLE
    AS $$
  select distinct on (btrim(t.a), t.f) btrim(t.a), t.f, btrim(t.v), coalesce(t.s, true)
    from unnest(p_apartments, p_fields, p_values,
                coalesce(p_may_suggest,
                         array_fill(true, array[coalesce(array_length(p_apartments, 1), 0)])))
           as t(a, f, v, s)
   where btrim(coalesce(t.a, '')) <> ''
     and t.f = any (array['owner_name', 'owner_phone', 'owner_email',
                          'tenant_name', 'tenant_phone', 'tenant_email'])
     and nullif(btrim(coalesce(t.v, '')), '') is not null
   order by btrim(t.a), t.f;
$$;


--
-- Name: contact_sync_ingest(text[], text[], text[], boolean[]); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.contact_sync_ingest(p_apartments text[], p_fields text[], p_values text[], p_may_suggest boolean[] DEFAULT NULL::boolean[]) RETURNS TABLE(created integer, applied integer, suggested integer, closed integer)
    LANGUAGE plpgsql
    AS $$
declare
  v_created integer := 0;
  v_applied integer := 0;
  v_suggested integer := 0;
  v_closed integer := 0;
  v_n integer;
begin
  perform set_config('app.write_source', 'bllink', true);

  -- 1. Apartments missing from the registry: created with the names and
  --    addresses the report knows, flagged for review. NO phone — a phone
  --    links the apartment to the portal, and that waits for a decision
  --    (step 4 proposes it in this same run).
  insert into public.contacts (apartment_number, owner_name, owner_email,
                               tenant_name, tenant_email, source, needs_review)
  select a.apt,
         max(i.value) filter (where i.field = 'owner_name'),
         max(i.value) filter (where i.field = 'owner_email'),
         max(i.value) filter (where i.field = 'tenant_name'),
         max(i.value) filter (where i.field = 'tenant_email'),
         'bllink_sync', true
    from (select distinct btrim(x) as apt
            from unnest(p_apartments) x
           where btrim(coalesce(x, '')) <> '') a
    left join public.contact_sync_incoming(p_apartments, p_fields, p_values, p_may_suggest) i
           on i.apartment_number = a.apt
   group by a.apt
  on conflict (apartment_number) do nothing;
  get diagnostics v_created = row_count;

  -- 2. Names and addresses we simply do not have: written straight in.
  --    Phones are NOT here any more — see step 4.
  update public.contacts c set owner_name = i.value
    from public.contact_sync_incoming(p_apartments, p_fields, p_values, p_may_suggest) i
   where c.apartment_number = i.apartment_number and i.field = 'owner_name'
     and nullif(btrim(coalesce(c.owner_name, '')), '') is null;
  get diagnostics v_n = row_count; v_applied := v_applied + v_n;

  update public.contacts c set owner_email = i.value
    from public.contact_sync_incoming(p_apartments, p_fields, p_values, p_may_suggest) i
   where c.apartment_number = i.apartment_number and i.field = 'owner_email'
     and nullif(btrim(coalesce(c.owner_email, '')), '') is null;
  get diagnostics v_n = row_count; v_applied := v_applied + v_n;

  update public.contacts c set tenant_name = i.value
    from public.contact_sync_incoming(p_apartments, p_fields, p_values, p_may_suggest) i
   where c.apartment_number = i.apartment_number and i.field = 'tenant_name'
     and nullif(btrim(coalesce(c.tenant_name, '')), '') is null;
  get diagnostics v_n = row_count; v_applied := v_applied + v_n;

  update public.contacts c set tenant_email = i.value
    from public.contact_sync_incoming(p_apartments, p_fields, p_values, p_may_suggest) i
   where c.apartment_number = i.apartment_number and i.field = 'tenant_email'
     and nullif(btrim(coalesce(c.tenant_email, '')), '') is null;
  get diagnostics v_n = row_count; v_applied := v_applied + v_n;

  -- 3. Open FIELD suggestions the live value already satisfies.
  update public.contact_sync_suggestions s
     set status = 'obsolete', resolved_at = now()
    from public.contacts c
   where s.status = 'pending'
     and s.phone_e164 is null
     and c.apartment_number = s.apartment_number
     and public.contact_value_norm(s.field, s.proposed_value)
         is not distinct from public.contact_value_norm(s.field,
           case s.field
             when 'owner_name'   then c.owner_name
             when 'owner_phone'  then c.owner_phone
             when 'owner_email'  then c.owner_email
             when 'tenant_name'  then c.tenant_name
             when 'tenant_phone' then c.tenant_phone
             else c.tenant_email end);
  get diagnostics v_closed = row_count;

  -- 3b. Open FIELD questions the source has stopped asking.
  update public.contact_sync_suggestions s
     set status = 'obsolete', resolved_at = now()
    from public.contact_sync_incoming(p_apartments, p_fields, p_values, p_may_suggest) i
    join public.contacts c on c.apartment_number = i.apartment_number
   where s.status = 'pending'
     and s.phone_e164 is null
     and s.apartment_number = i.apartment_number
     and s.field = i.field
     and public.contact_value_norm(i.field, i.value)
         is not distinct from public.contact_value_norm(i.field,
           case i.field
             when 'owner_name'   then c.owner_name
             when 'owner_phone'  then c.owner_phone
             when 'owner_email'  then c.owner_email
             when 'tenant_name'  then c.tenant_name
             when 'tenant_phone' then c.tenant_phone
             else c.tenant_email end);
  get diagnostics v_n = row_count; v_closed := v_closed + v_n;

  -- 4. The conflicts — and every phone we do not hold yet. Ours stands; the
  --    difference waits for a decision.
  insert into public.contact_sync_suggestions
    (apartment_number, field, current_value, proposed_value, source)
  select i.apartment_number, i.field, cur.v, i.value, 'bllink'
    from public.contact_sync_incoming(p_apartments, p_fields, p_values, p_may_suggest) i
    join public.contacts c on c.apartment_number = i.apartment_number
    cross join lateral (select case i.field
                                 when 'owner_name'   then c.owner_name
                                 when 'owner_phone'  then c.owner_phone
                                 when 'owner_email'  then c.owner_email
                                 when 'tenant_name'  then c.tenant_name
                                 when 'tenant_phone' then c.tenant_phone
                                 else c.tenant_email end as v) cur
   where (nullif(btrim(coalesce(cur.v, '')), '') is not null
          or i.field in ('owner_phone', 'tenant_phone'))
     and i.may_suggest
     and public.contact_value_norm(i.field, cur.v)
         is distinct from public.contact_value_norm(i.field, i.value)
     and not exists (
       select 1 from public.contact_sync_suggestions r
        where r.apartment_number = i.apartment_number
          and r.field = i.field
          and r.status = 'rejected'
          and public.contact_value_norm(r.field, r.proposed_value)
              is not distinct from public.contact_value_norm(i.field, i.value))
  on conflict (apartment_number, field) where status = 'pending' and phone_e164 is null
  do update set current_value  = excluded.current_value,
                proposed_value = excluded.proposed_value,
                created_at     = now()
   where public.contact_value_norm(public.contact_sync_suggestions.field,
                                   public.contact_sync_suggestions.proposed_value)
         is distinct from public.contact_value_norm(excluded.field, excluded.proposed_value);
  get diagnostics v_suggested = row_count;

  perform set_config('app.write_source', '', true);

  created := v_created; applied := v_applied; suggested := v_suggested; closed := v_closed;
  return next;
end;
$$;


--
-- Name: contact_value_norm(text, text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.contact_value_norm(p_field text, raw text) RETURNS text
    LANGUAGE plpgsql IMMUTABLE
    AS $$
declare
  cleaned text;
  first_part text;
  digits text;
begin
  if raw is null then return null; end if;

  -- Invisible formatting characters are never part of a value.
  cleaned := regexp_replace(raw, '[​-‏‪-‮⁦-⁩﻿]', '', 'g');

  -- Addresses: case never matters, and neither does a stray space.
  if p_field in ('owner_email', 'tenant_email') then
    return nullif(lower(btrim(cleaned)), '');
  end if;

  if p_field in ('owner_phone', 'tenant_phone') then
    -- A cell can hold two numbers ("054… / 050…") — the first one is the value,
    -- exactly as splitOwnerTenantPhones() and normalizePhone() read it.
    first_part := btrim(split_part(regexp_replace(cleaned, '[/,;|]', '/', 'g'), '/', 1));
    digits := regexp_replace(first_part, '\D', '', 'g');
    if digits = '' then return null; end if;
    if left(digits, 2) = '00' then digits := substr(digits, 3); end if;
    if left(digits, 3) = '972' then digits := '0' || substr(digits, 4); end if;
    return digits;
  end if;

  return nullif(lower(btrim(regexp_replace(cleaned, '\s+', ' ', 'g'))), '');
end;
$$;


--
-- Name: FUNCTION contact_value_norm(p_field text, raw text); Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON FUNCTION public.contact_value_norm(p_field text, raw text) IS 'Equality rule for the resident-list fields Bllink supplies. Phones compare as local digits, names case- and whitespace-insensitively. Never rejects a value — it only decides whether two values differ.';


--
-- Name: contacts_field_provenance(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.contacts_field_provenance() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
declare
  v_source text := coalesce(nullif(current_setting('app.write_source', true), ''), 'manual');
  f text;
  old_v text;
  new_v text;
begin
  foreach f in array array['owner_name', 'owner_phone', 'owner_email',
                           'tenant_name', 'tenant_phone', 'tenant_email'] loop
    new_v := case f
               when 'owner_name'   then new.owner_name
               when 'owner_phone'  then new.owner_phone
               when 'owner_email'  then new.owner_email
               when 'tenant_name'  then new.tenant_name
               when 'tenant_phone' then new.tenant_phone
               else new.tenant_email end;
    old_v := case
               when tg_op = 'INSERT'   then null
               when f = 'owner_name'   then old.owner_name
               when f = 'owner_phone'  then old.owner_phone
               when f = 'owner_email'  then old.owner_email
               when f = 'tenant_name'  then old.tenant_name
               when f = 'tenant_phone' then old.tenant_phone
               else old.tenant_email end;

    -- Only a real change counts: re-saving the same number in a different
    -- spelling is not an edit, and must not restamp the field.
    continue when public.contact_value_norm(f, new_v)
                  is not distinct from public.contact_value_norm(f, old_v);

    insert into public.contact_field_sources (apartment_number, field, source, updated_at)
    values (new.apartment_number, f, v_source, now())
    on conflict (apartment_number, field)
      do update set source = excluded.source, updated_at = excluded.updated_at;

    -- The local value now IS what Bllink proposed — whoever typed it. There is
    -- nothing left to approve, so the open suggestion closes itself and the
    -- badge disappears from the card at once, not at tomorrow's sync.
    update public.contact_sync_suggestions s
       set status = 'obsolete', resolved_at = now()
     where s.apartment_number = new.apartment_number
       and s.field = f
       and s.status = 'pending'
       and public.contact_value_norm(f, s.proposed_value)
           is not distinct from public.contact_value_norm(f, new_v);
  end loop;

  return null;
end;
$$;


--
-- Name: portal_link_suggest(uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.portal_link_suggest(p_scrape_id uuid) RETURNS TABLE(suggested_link integer, suggested_unlink integer, suggested_name integer, closed integer)
    LANGUAGE plpgsql
    AS $$
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


--
-- Name: FUNCTION portal_link_suggest(p_scrape_id uuid); Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON FUNCTION public.portal_link_suggest(p_scrape_id uuid) IS 'Compare one scrape''s resident list with the portal links, matched by phone first: a listed person the card does not carry → portal_link; a linked phone Bllink does not list in that apartment, or lists only as inactive → portal_unlink (with unlink_reason); a phone listed under another name → a name suggestion for its card field. Suggests only — nothing is linked or unlinked here.';


--
-- Name: portal_owner_e164(text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.portal_owner_e164(raw text) RETURNS text
    LANGUAGE plpgsql IMMUTABLE
    AS $_$
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
$_$;


--
-- Name: FUNCTION portal_owner_e164(raw text); Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON FUNCTION public.portal_owner_e164(raw text) IS 'Owner phone -> E.164 roster key, or NULL. Mirrors toPortalE164() in src/lib/portal/phone.ts; pinned to it by tests/portal-owner-roster.test.ts.';


--
-- Name: portal_roster_desired(text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.portal_roster_desired(p_apartment text) RETURNS TABLE(phone_e164 text, source_table text, source_row_id uuid, owner_name text, role text, source_field text)
    LANGUAGE sql STABLE
    AS $$
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


--
-- Name: FUNCTION portal_roster_desired(p_apartment text); Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON FUNCTION public.portal_roster_desired(p_apartment text) IS 'The roster an apartment SHOULD have: one row per E.164 phone found in its records in a portal role (owner field / extra owners / operator field / the tenant-or-operator section when the card shows it), with the record, the name and the role.';


--
-- Name: portal_roster_from_contact(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.portal_roster_from_contact() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
begin
  perform public.portal_roster_upsert(new.apartment_number, new.owner_name, new.owner_phone);
  return null;
end;
$$;


--
-- Name: portal_roster_from_contact_person(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.portal_roster_from_contact_person() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
declare
  apt text;
begin
  if new.role is distinct from 'owner' then return null; end if;
  select c.apartment_number into apt from public.contacts c where c.id = new.contact_id;
  perform public.portal_roster_upsert(apt, new.name, new.phone);
  return null;
end;
$$;


--
-- Name: portal_roster_sync(text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.portal_roster_sync(p_apartment text) RETURNS void
    LANGUAGE plpgsql
    AS $$
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


--
-- Name: FUNCTION portal_roster_sync(p_apartment text); Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON FUNCTION public.portal_roster_sync(p_apartment text) IS 'Recompute one apartment''s portal roster from its records in the three portal roles, both directions, every link change logged in audit_log. Runs from the deferred triggers portal_roster_sync_*; never re-links a detached row in the role it was detached in.';


--
-- Name: portal_roster_sync_from_contact(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.portal_roster_sync_from_contact() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
begin
  -- DELETE is not an event here: the roster's FK cascades with the apartment.
  perform public.portal_roster_sync(new.apartment_number);
  return null;
end;
$$;


--
-- Name: portal_roster_sync_from_contact_person(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.portal_roster_sync_from_contact_person() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
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


--
-- Name: portal_roster_upsert(text, text, text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.portal_roster_upsert(p_apartment text, p_name text, p_raw_phone text) RETURNS void
    LANGUAGE plpgsql
    AS $$
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


--
-- Name: portal_unlink_close(uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.portal_unlink_close(p_scrape_id uuid) RETURNS integer
    LANGUAGE plpgsql
    AS $$
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


--
-- Name: FUNCTION portal_unlink_close(p_scrape_id uuid); Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON FUNCTION public.portal_unlink_close(p_scrape_id uuid) IS 'Closes (obsolete, never deletes) every open portal_unlink of the apartments one scrape''s list spoke about that the rule no longer supports — the link is gone, Bllink lists the phone / the name, or it is an extra owner the list does not mention — one audit_log row each (contact_suggestion_closed).';


--
-- Name: reconcile_wa_campaign(uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.reconcile_wa_campaign(p_campaign uuid) RETURNS void
    LANGUAGE plpgsql
    AS $$
declare c record;
begin
  select
    count(*)                                    as total,
    count(*) filter (where status='pending')    as pending,
    count(*) filter (where status='processing') as processing,
    count(*) filter (where status='sent')       as sent,
    count(*) filter (where status='failed')     as failed,
    count(*) filter (where status='skipped')    as skipped,
    count(*) filter (where status='cancelled')  as cancelled
  into c
  from public.wa_campaign_recipients where campaign_id = p_campaign;

  update public.wa_campaigns w set
    total_count=c.total, pending_count=c.pending, processing_count=c.processing,
    sent_count=c.sent, failed_count=c.failed, skipped_count=c.skipped,
    cancelled_count=c.cancelled,
    status = case
      when w.status in ('cancelled','draft','paused') then w.status
      when (c.pending + c.processing) = 0 and c.total > 0
        then case when c.failed > 0 then 'completed_with_errors' else 'completed' end
      else w.status end,
    completed_at = case
      when w.status not in ('cancelled','draft','paused')
       and (c.pending + c.processing) = 0 and c.total > 0 and w.completed_at is null
        then now() else w.completed_at end
  where w.id = p_campaign;
end $$;


--
-- Name: touch_updated_at(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.touch_updated_at() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
begin
  new.updated_at = now();
  return new;
end;
$$;


--
-- Name: wa_touch_updated_at(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.wa_touch_updated_at() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
begin new.updated_at = now(); return new; end $$;


SET default_tablespace = '';

SET default_table_access_method = heap;

--
-- Name: apartment_owner_phones; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.apartment_owner_phones (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    apartment_number text NOT NULL,
    owner_name text,
    phone_e164 text NOT NULL,
    is_active boolean DEFAULT true NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    created_by uuid,
    source_table text,
    source_row_id uuid,
    detached_at timestamp with time zone,
    detached_by uuid,
    detach_reason text,
    role text DEFAULT 'owner'::text NOT NULL,
    source_field text,
    CONSTRAINT apartment_owner_phones_detach_shape_check CHECK (((detached_at IS NULL) = (detach_reason IS NULL))),
    CONSTRAINT apartment_owner_phones_detached_inactive_check CHECK (((detached_at IS NULL) OR (NOT is_active))),
    CONSTRAINT apartment_owner_phones_phone_e164_check CHECK (((phone_e164 ~ '^\+9725[0-9]{8}$'::text) OR ((phone_e164 !~ '^\+972'::text) AND (phone_e164 ~ '^\+[1-9][0-9]{6,14}$'::text)))),
    CONSTRAINT apartment_owner_phones_role_check CHECK ((role = ANY (ARRAY['owner'::text, 'tenant'::text, 'operator'::text]))),
    CONSTRAINT apartment_owner_phones_source_field_check CHECK (((source_field IS NULL) OR (source_field = ANY (ARRAY['owner_phone'::text, 'tenant_phone'::text, 'operator_phone'::text])))),
    CONSTRAINT apartment_owner_phones_source_field_shape_check CHECK (((NOT (source_table IS DISTINCT FROM 'contacts'::text)) = (source_field IS NOT NULL))),
    CONSTRAINT apartment_owner_phones_source_pair_check CHECK (((source_table IS NULL) = (source_row_id IS NULL))),
    CONSTRAINT apartment_owner_phones_source_table_check CHECK (((source_table IS NULL) OR (source_table = ANY (ARRAY['contacts'::text, 'contact_people'::text]))))
);


--
-- Name: TABLE apartment_owner_phones; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.apartment_owner_phones IS 'Owners-portal roster: which phone (E.164) may sign in on behalf of which apartment. Several owners per apartment and several apartments per phone are both normal. is_active = false revokes access without losing the record. Israeli MOBILE only — the code is delivered over WhatsApp.';


--
-- Name: COLUMN apartment_owner_phones.owner_name; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.apartment_owner_phones.owner_name IS 'Display name for the admin log ("בעלים" column). Nullable: some rows come from contact_people entries that have a phone but no name.';


--
-- Name: COLUMN apartment_owner_phones.phone_e164; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.apartment_owner_phones.phone_e164 IS 'E.164. Israel: mobile only (+9725XXXXXXXX). Other countries: general E.164 (+CC…, 7–15 digits). Same rule as toPortalE164().';


--
-- Name: COLUMN apartment_owner_phones.source_table; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.apartment_owner_phones.source_table IS 'Which owner record carries this phone today: contacts (owner_phone) or contact_people (role owner). NULL = no record holds it (an inactive row). Written by portal_roster_sync only.';


--
-- Name: COLUMN apartment_owner_phones.source_row_id; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.apartment_owner_phones.source_row_id IS 'contacts.id or contact_people.id of that record. Not an FK: the apartment card deletes and re-inserts contact_people on every save, and the sync repoints this at commit.';


--
-- Name: COLUMN apartment_owner_phones.detached_at; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.apartment_owner_phones.detached_at IS 'A deliberate detach (admin / approved clean-up / owner replaced). Sticky: the sync does not re-link while the owner record still holds the phone; released when the phone leaves every owner record of the apartment.';


--
-- Name: COLUMN apartment_owner_phones.detach_reason; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.apartment_owner_phones.detach_reason IS 'Why it was detached: admin · audit_2026_10 · owner_replaced (free text, the audit_log entry carries the detail).';


--
-- Name: COLUMN apartment_owner_phones.role; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.apartment_owner_phones.role IS 'The role the phone holds in the apartment: owner · tenant · operator. The widest wins when one phone holds several (owner > operator > tenant). Written by portal_roster_sync only. owner_name holds the name of whoever carries the phone, whatever the role.';


--
-- Name: COLUMN apartment_owner_phones.source_field; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.apartment_owner_phones.source_field IS 'For source_table = contacts: which field carries the phone (owner_phone · tenant_phone · operator_phone). NULL for contact_people.';


--
-- Name: app_settings; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.app_settings (
    key text NOT NULL,
    value jsonb NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_by uuid
);


--
-- Name: TABLE app_settings; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.app_settings IS 'Generic admin-only key/value settings store (jsonb).';


--
-- Name: COLUMN app_settings.value; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.app_settings.value IS 'Schema is per-key. key=smtp: { user, fromName, passEnc:{ iv, ct, tag } }. key=green_api: { instanceId, tokenEnc:{ iv, ct, tag } }. Enc fields are base64 (AES-256-GCM).';


--
-- Name: areas; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.areas (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    name text NOT NULL,
    description text,
    created_by uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    area_type text DEFAULT 'closed_room'::text NOT NULL,
    color text,
    CONSTRAINT areas_area_type_check CHECK ((area_type = ANY (ARRAY['closed_room'::text, 'open_space'::text])))
);


--
-- Name: audit_log; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.audit_log (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    actor_user_id uuid,
    action text NOT NULL,
    entity_type text NOT NULL,
    entity_id text,
    changes jsonb,
    metadata jsonb,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    actor_name text
);


--
-- Name: COLUMN audit_log.actor_name; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.audit_log.actor_name IS 'Snapshot of the acting user''s name — survives the user''s deletion (actor_user_id goes NULL then).';


--
-- Name: auth_rate_limits; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.auth_rate_limits (
    id bigint NOT NULL,
    bucket text NOT NULL,
    hit_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: auth_rate_limits_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

ALTER TABLE public.auth_rate_limits ALTER COLUMN id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME public.auth_rate_limits_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: bllink_scrape_rows; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.bllink_scrape_rows (
    id bigint NOT NULL,
    scrape_id uuid NOT NULL,
    apartment_number text NOT NULL,
    owner_name text,
    phone_primary text,
    total_debt numeric(12,2) DEFAULT 0 NOT NULL,
    monthly_debt numeric(12,2) DEFAULT 0 NOT NULL,
    special_debt numeric(12,2) DEFAULT 0 NOT NULL,
    management_months_raw text,
    notes text,
    raw jsonb DEFAULT '{}'::jsonb NOT NULL,
    list_owner_email text,
    list_tenant_email text,
    list_owner_name text,
    list_owner_phone text,
    list_tenant_name text,
    list_tenant_phone text
);


--
-- Name: TABLE bllink_scrape_rows; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.bllink_scrape_rows IS 'Raw rows of one Bllink shadow scrape, in the CRM debtor_records column naming (D total, E monthly, F months text, G special, H notes). raw = the eight source cells.';


--
-- Name: COLUMN bllink_scrape_rows.list_owner_email; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.bllink_scrape_rows.list_owner_email IS 'From Bllink''s tenant-list endpoint, not from the debt export (which has no address). NULL when that read failed — the scrape does not fail with it.';


--
-- Name: COLUMN bllink_scrape_rows.list_owner_name; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.bllink_scrape_rows.list_owner_name IS 'From Bllink''s resident list, raw. NULL when that read failed — the scrape does not fail with it, and the sync falls back to the export''s labelled name cell for that run.';


--
-- Name: bllink_scrape_rows_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.bllink_scrape_rows_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: bllink_scrape_rows_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.bllink_scrape_rows_id_seq OWNED BY public.bllink_scrape_rows.id;


--
-- Name: bllink_scrapes; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.bllink_scrapes (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    started_at timestamp with time zone DEFAULT now() NOT NULL,
    finished_at timestamp with time zone,
    status text DEFAULT 'running'::text NOT NULL,
    error_stage text,
    error_message text,
    rows_count integer,
    xlsx_sha256 text,
    compare_summary jsonb,
    tenant_list_ok boolean DEFAULT false NOT NULL,
    list_people jsonb,
    CONSTRAINT bllink_scrapes_error_stage_check CHECK (((error_stage IS NULL) OR (error_stage = ANY (ARRAY['login'::text, 'navigate'::text, 'download'::text, 'parse'::text, 'compare'::text])))),
    CONSTRAINT bllink_scrapes_status_check CHECK ((status = ANY (ARRAY['running'::text, 'success'::text, 'error'::text])))
);


--
-- Name: TABLE bllink_scrapes; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.bllink_scrapes IS 'One row per shadow scrape of the Bllink udnp report (scripts/bllink-scrape.ts). compare_summary = diff against the CRM snapshot of the same run.';


--
-- Name: COLUMN bllink_scrapes.tenant_list_ok; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.bllink_scrapes.tenant_list_ok IS 'Did this scrape manage to read the resident list? false = names and phones in it came from the debt export alone.';


--
-- Name: COLUMN bllink_scrapes.list_people; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.bllink_scrapes.list_people IS 'Bllink''s resident list, every ACTIVE person: {"<apartment>": [{"role": "owner"|"tenant", "name": …, "phone": …, "primary": bool}]}. Raw values. NULL when the list read failed (tenant_list_ok = false) — then nothing is compared.';


--
-- Name: calendar_event_participants; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.calendar_event_participants (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    event_id uuid NOT NULL,
    participant_source text NOT NULL,
    participant_id uuid,
    display_name_cache text,
    email_cache text,
    attendance_status text DEFAULT 'pending'::text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT calendar_event_participants_attendance_status_check CHECK ((attendance_status = ANY (ARRAY['pending'::text, 'accepted'::text, 'declined'::text]))),
    CONSTRAINT calendar_event_participants_participant_source_check CHECK ((participant_source = ANY (ARRAY['user'::text, 'contact'::text, 'external'::text])))
);


--
-- Name: calendar_events; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.calendar_events (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    title text NOT NULL,
    item_kind text DEFAULT 'meeting'::text NOT NULL,
    event_date date NOT NULL,
    start_datetime timestamp with time zone,
    end_datetime timestamp with time zone,
    is_all_day boolean DEFAULT false NOT NULL,
    location text,
    description text,
    color_key text DEFAULT 'blue'::text NOT NULL,
    status text DEFAULT 'scheduled'::text NOT NULL,
    owner_user_id uuid,
    recurrence_enabled boolean DEFAULT false NOT NULL,
    recurrence_type text,
    recurrence_interval integer DEFAULT 1 NOT NULL,
    recurrence_end_type text DEFAULT 'never'::text NOT NULL,
    recurrence_until_date date,
    recurrence_count integer,
    parent_series_id uuid,
    is_exception boolean DEFAULT false NOT NULL,
    source_type text DEFAULT 'manual'::text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT calendar_events_item_kind_check CHECK ((item_kind = ANY (ARRAY['meeting'::text, 'event'::text]))),
    CONSTRAINT calendar_events_recurrence_end_type_check CHECK ((recurrence_end_type = ANY (ARRAY['never'::text, 'until_date'::text, 'count'::text]))),
    CONSTRAINT calendar_events_recurrence_type_check CHECK ((recurrence_type = ANY (ARRAY['daily'::text, 'weekly'::text, 'monthly'::text, 'yearly'::text]))),
    CONSTRAINT calendar_events_source_type_check CHECK ((source_type = ANY (ARRAY['manual'::text, 'generated_occurrence'::text]))),
    CONSTRAINT calendar_events_status_check CHECK ((status = ANY (ARRAY['scheduled'::text, 'completed'::text, 'cancelled'::text])))
);


--
-- Name: chat_messages; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.chat_messages (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    debtor_id uuid,
    contact_phone text NOT NULL,
    chat_id text,
    external_message_id text,
    link_status text DEFAULT 'linked'::text NOT NULL,
    direction text NOT NULL,
    message_type text DEFAULT 'text'::text NOT NULL,
    content text,
    status text DEFAULT 'pending'::text NOT NULL,
    error_detail text,
    sent_by uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    broadcast_id uuid,
    media_url text,
    read_at timestamp with time zone,
    instance_id uuid,
    supplier_id uuid,
    attachment_name text,
    attachment_mime text,
    attachment_size integer,
    sent_by_name text,
    CONSTRAINT chat_messages_direction_check CHECK ((direction = ANY (ARRAY['sent'::text, 'received'::text]))),
    CONSTRAINT chat_messages_link_status_check CHECK ((link_status = ANY (ARRAY['linked'::text, 'unlinked'::text]))),
    CONSTRAINT chat_messages_message_type_check CHECK ((message_type = ANY (ARRAY['text'::text, 'image'::text, 'document'::text]))),
    CONSTRAINT chat_messages_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'queued'::text, 'sent'::text, 'delivered'::text, 'read'::text, 'failed'::text])))
);


--
-- Name: COLUMN chat_messages.sent_by_name; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.chat_messages.sent_by_name IS 'Snapshot of the sending staff user''s name (full_name, else username). Shown once the user is deleted; the live name wins while they exist.';


--
-- Name: chip_events; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.chip_events (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    chip_id uuid NOT NULL,
    event_type text NOT NULL,
    old_value jsonb,
    new_value jsonb,
    reason text,
    actor_id uuid,
    actor_name text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT chip_events_event_type_check CHECK ((event_type = ANY (ARRAY['issued'::text, 'deactivated'::text, 'reactivated'::text, 'reassigned'::text, 'note'::text, 'controller_synced'::text])))
);


--
-- Name: chips; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.chips (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    chip_number text NOT NULL,
    chip_type text DEFAULT 'physical'::text NOT NULL,
    contact_id uuid NOT NULL,
    apartment_number text NOT NULL,
    status text DEFAULT 'active'::text NOT NULL,
    resident_role text NOT NULL,
    holder_name text,
    holder_phone text,
    issued_at timestamp with time zone DEFAULT now() NOT NULL,
    issued_by uuid,
    issued_by_name text,
    deactivated_at timestamp with time zone,
    deactivated_by uuid,
    deactivated_by_name text,
    deactivation_reason text,
    controller_synced boolean DEFAULT false NOT NULL,
    controller_synced_at timestamp with time zone,
    app_platform text,
    app_invite_status text,
    app_expires_at timestamp with time zone,
    issuance_fee numeric(10,2),
    fee_charged boolean DEFAULT false NOT NULL,
    limit_override_reason text,
    notes text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT chips_app_invite_status_check CHECK (((app_invite_status IS NULL) OR (app_invite_status = ANY (ARRAY['pending'::text, 'active'::text, 'expired'::text])))),
    CONSTRAINT chips_app_platform_check CHECK (((app_platform IS NULL) OR (app_platform = ANY (ARRAY['ios'::text, 'android'::text, 'unknown'::text])))),
    CONSTRAINT chips_chip_type_check CHECK ((chip_type = ANY (ARRAY['physical'::text, 'app'::text]))),
    CONSTRAINT chips_deactivation_reason_check CHECK (((deactivation_reason IS NULL) OR (deactivation_reason = ANY (ARRAY['lost'::text, 'stolen'::text, 'damaged'::text, 'returned'::text, 'moved_out'::text, 'unknown'::text])))),
    CONSTRAINT chips_holder_identity_check CHECK ((((resident_role = ANY (ARRAY['other'::text, 'staff'::text])) AND (holder_name IS NOT NULL)) OR ((resident_role = ANY (ARRAY['owner'::text, 'tenant'::text, 'operator'::text])) AND (contact_id IS NOT NULL)))),
    CONSTRAINT chips_inactive_requires_reason CHECK (((status = 'active'::text) OR (deactivation_reason IS NOT NULL))),
    CONSTRAINT chips_resident_role_check CHECK (((resident_role IS NULL) OR (resident_role = ANY (ARRAY['owner'::text, 'tenant'::text, 'operator'::text, 'staff'::text, 'other'::text])))),
    CONSTRAINT chips_status_check CHECK ((status = ANY (ARRAY['active'::text, 'inactive'::text])))
);


--
-- Name: comments; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.comments (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    debtor_id uuid NOT NULL,
    apartment_number text NOT NULL,
    content text NOT NULL,
    author_id uuid,
    author_name text NOT NULL,
    author_email text,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: completed_actions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.completed_actions (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    debtor_id uuid NOT NULL,
    apartment_number text NOT NULL,
    description text NOT NULL,
    due_date date,
    completed_at timestamp with time zone DEFAULT now() NOT NULL,
    completed_by uuid,
    completed_by_name text NOT NULL
);


--
-- Name: contact_field_sources; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.contact_field_sources (
    apartment_number text NOT NULL,
    field text NOT NULL,
    source text NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT contact_field_sources_field_check CHECK ((field = ANY (ARRAY['owner_name'::text, 'owner_phone'::text, 'owner_email'::text, 'tenant_name'::text, 'tenant_phone'::text, 'tenant_email'::text]))),
    CONSTRAINT contact_field_sources_source_check CHECK ((source = ANY (ARRAY['manual'::text, 'bllink'::text])))
);


--
-- Name: TABLE contact_field_sources; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.contact_field_sources IS 'Provenance of the resident-list fields Bllink also supplies: who last CHANGED each one. Written by a trigger, so no call site can forget.';


--
-- Name: contact_people; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.contact_people (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    contact_id uuid NOT NULL,
    role text NOT NULL,
    name text,
    phone text,
    email text,
    is_primary_contact boolean DEFAULT true NOT NULL,
    sort_order integer DEFAULT 0 NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT contact_people_role_check CHECK ((role = ANY (ARRAY['owner'::text, 'tenant'::text])))
);


--
-- Name: TABLE contact_people; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.contact_people IS 'Additional owners/tenants of an apartment. The first person of each role lives in contacts.owner_*/tenant_*; these are the extras. is_primary_contact = receives WhatsApp messages/broadcasts.';


--
-- Name: contact_sync_suggestions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.contact_sync_suggestions (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    apartment_number text NOT NULL,
    field text NOT NULL,
    current_value text,
    proposed_value text NOT NULL,
    source text DEFAULT 'bllink'::text NOT NULL,
    status text DEFAULT 'pending'::text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    resolved_at timestamp with time zone,
    resolved_by uuid,
    phone_e164 text,
    person_role text,
    person_name text,
    unlink_reason text,
    CONSTRAINT contact_sync_suggestions_field_check CHECK ((field = ANY (ARRAY['owner_name'::text, 'owner_phone'::text, 'owner_email'::text, 'tenant_name'::text, 'tenant_phone'::text, 'tenant_email'::text, 'portal_link'::text, 'portal_unlink'::text]))),
    CONSTRAINT contact_sync_suggestions_person_role_check CHECK (((person_role IS NULL) OR (person_role = ANY (ARRAY['owner'::text, 'tenant'::text, 'operator'::text])))),
    CONSTRAINT contact_sync_suggestions_person_shape_check CHECK (((field = ANY (ARRAY['portal_link'::text, 'portal_unlink'::text])) = (phone_e164 IS NOT NULL))),
    CONSTRAINT contact_sync_suggestions_resolution_shape CHECK ((((status = 'pending'::text) AND (resolved_at IS NULL)) OR ((status <> 'pending'::text) AND (resolved_at IS NOT NULL)))),
    CONSTRAINT contact_sync_suggestions_source_check CHECK ((source = 'bllink'::text)),
    CONSTRAINT contact_sync_suggestions_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'approved'::text, 'rejected'::text, 'obsolete'::text]))),
    CONSTRAINT contact_sync_suggestions_unlink_reason_check CHECK (((unlink_reason IS NULL) OR ((field = 'portal_unlink'::text) AND (unlink_reason = ANY (ARRAY['phone_not_listed'::text, 'inactive'::text])))))
);


--
-- Name: TABLE contact_sync_suggestions; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.contact_sync_suggestions IS 'Bllink proposals for the resident list. One OPEN row per apartment+field; approved / rejected / obsolete rows are history. obsolete = the local value changed by itself and now matches the proposal, so there was nothing left to decide.';


--
-- Name: COLUMN contact_sync_suggestions.resolved_by; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.contact_sync_suggestions.resolved_by IS 'The user who pressed approve/reject. NULL on an obsolete row — nobody decided it.';


--
-- Name: COLUMN contact_sync_suggestions.phone_e164; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.contact_sync_suggestions.phone_e164 IS 'portal_link / portal_unlink only: the phone (E.164) the suggestion is about. NULL for a field suggestion.';


--
-- Name: COLUMN contact_sync_suggestions.person_role; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.contact_sync_suggestions.person_role IS 'portal_link: Bllink''s role for the person (owner / tenant). portal_unlink: the role of the link here.';


--
-- Name: COLUMN contact_sync_suggestions.unlink_reason; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.contact_sync_suggestions.unlink_reason IS 'portal_unlink only: why — phone_not_listed (Bllink does not list the phone in that apartment) or inactive (listed with isActive = false). NULL on every other row and on unlinks raised before 20261003191659.';


--
-- Name: contacts; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.contacts (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    apartment_number text NOT NULL,
    owner_name text,
    owner_phone text,
    owner_email text,
    tenant_name text,
    tenant_phone text,
    tenant_email text,
    resident_type text DEFAULT 'owner'::text NOT NULL,
    operator_id uuid,
    owner_is_primary_contact boolean DEFAULT true NOT NULL,
    tenant_is_primary_contact boolean DEFAULT true NOT NULL,
    operator_is_primary_contact boolean DEFAULT false NOT NULL,
    address text,
    notes text,
    tags text[] DEFAULT '{}'::text[] NOT NULL,
    whatsapp_profile_image_url text,
    whatsapp_profile_sync_status text,
    whatsapp_profile_last_synced_at timestamp with time zone,
    whatsapp_profile_sync_error text,
    last_whatsapp_sent_at timestamp with time zone,
    last_synced_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    created_by uuid,
    apartment_size_sqm numeric(10,2),
    management_fee numeric(12,2),
    operator_name text,
    operator_phone text,
    unit_type text DEFAULT 'apartment'::text NOT NULL,
    source text,
    needs_review boolean DEFAULT false NOT NULL,
    CONSTRAINT contacts_resident_type_check CHECK ((resident_type = ANY (ARRAY['owner'::text, 'tenant'::text, 'operator'::text]))),
    CONSTRAINT contacts_source_check CHECK (((source IS NULL) OR (source = ANY (ARRAY['residents_import'::text, 'manual'::text, 'bllink_sync'::text, 'seed'::text])))),
    CONSTRAINT contacts_unit_type_check CHECK ((unit_type = ANY (ARRAY['apartment'::text, 'storage'::text, 'parking'::text, 'common'::text, 'staff'::text, 'other'::text]))),
    CONSTRAINT contacts_whatsapp_profile_sync_status_check CHECK ((whatsapp_profile_sync_status = ANY (ARRAY['pending'::text, 'synced'::text, 'no_avatar'::text, 'unavailable'::text, 'failed'::text])))
);


--
-- Name: COLUMN contacts.apartment_size_sqm; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.contacts.apartment_size_sqm IS 'Apartment floor area in square metres (manual field, never written by an import).';


--
-- Name: COLUMN contacts.management_fee; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.contacts.management_fee IS 'Agreed monthly management fee for the apartment (manual). NOT the synced debt in debtors.management_fees.';


--
-- Name: debtor_debt_snapshots; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.debtor_debt_snapshots (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    apartment_number text NOT NULL,
    total_debt numeric(12,2) DEFAULT 0 NOT NULL,
    snapshot_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: debtor_events; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.debtor_events (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    debtor_id uuid NOT NULL,
    event_type text NOT NULL,
    title text NOT NULL,
    description text,
    outcome text,
    metadata jsonb DEFAULT '{}'::jsonb NOT NULL,
    actor_id uuid,
    actor_name text,
    actor_email text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT debtor_events_event_type_check CHECK ((event_type = ANY (ARRAY['PHONE_CALL'::text, 'SMS'::text, 'WHATSAPP'::text, 'EMAIL'::text, 'MEETING'::text, 'ARCHIVE'::text, 'UNARCHIVE'::text, 'WARNING_LETTER'::text, 'LEGAL_PROCEEDING'::text, 'SYSTEM'::text, 'OTHER'::text])))
);


--
-- Name: debtors; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.debtors (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    apartment_number text NOT NULL,
    owner_name text,
    tenant_name text,
    address text,
    phone_owner text,
    phone_tenant text,
    email_owner text,
    email_tenant text,
    phones_raw text,
    operator_id uuid,
    total_debt numeric(10,2) DEFAULT 0 NOT NULL,
    management_fees numeric(10,2) DEFAULT 0 NOT NULL,
    monthly_debt text,
    hot_water_debt numeric(10,2) DEFAULT 0 NOT NULL,
    special_debt numeric(10,2) DEFAULT 0 NOT NULL,
    details text,
    is_archived boolean DEFAULT false NOT NULL,
    last_imported_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    legal_status_id uuid,
    legal_status_source text DEFAULT 'MANUAL'::text,
    legal_status_lock boolean DEFAULT false NOT NULL,
    legal_status_updated_at timestamp with time zone,
    legal_status_updated_by uuid,
    legal_status_updated_by_name text,
    notes text,
    next_action_date date,
    next_action_description text,
    last_contact_date date,
    phones_manual_override boolean DEFAULT false NOT NULL,
    archived_at timestamp with time zone,
    last_whatsapp_sent_at timestamp with time zone,
    phone_owner_raw_backup text,
    phone_tenant_raw_backup text,
    contact_id uuid
);


--
-- Name: COLUMN debtors.phone_owner_raw_backup; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.debtors.phone_owner_raw_backup IS 'Pre-015 raw phone_owner snapshot (rollback source for the phone cleanup).';


--
-- Name: COLUMN debtors.phone_tenant_raw_backup; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.debtors.phone_tenant_raw_backup IS 'Pre-015 raw phone_tenant snapshot (rollback source for the phone cleanup).';


--
-- Name: debtors_stale_import_text_backup; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.debtors_stale_import_text_backup (
    debtor_id uuid NOT NULL,
    apartment_number text NOT NULL,
    details text,
    monthly_debt text,
    cleared_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: TABLE debtors_stale_import_text_backup; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.debtors_stale_import_text_backup IS 'Pre-clearing snapshot of debtors.details / debtors.monthly_debt for apartments whose debt was fully settled (one-time cleanup 29/09/2026). Rollback source for migration 20260929043204; safe to drop once the cleanup is confirmed.';


--
-- Name: document_folders; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.document_folders (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    name text NOT NULL,
    parent_folder_id uuid,
    created_by uuid,
    is_archived boolean DEFAULT false NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    created_by_name text
);


--
-- Name: COLUMN document_folders.created_by_name; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.document_folders.created_by_name IS 'Snapshot of the creating user''s name — survives the user''s deletion.';


--
-- Name: documents; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.documents (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    folder_id uuid,
    file_name text NOT NULL,
    storage_path text NOT NULL,
    mime_type text,
    size_bytes bigint,
    entity_type text,
    entity_id text,
    uploaded_by uuid,
    is_archived boolean DEFAULT false NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    uploaded_by_name text
);


--
-- Name: COLUMN documents.uploaded_by_name; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.documents.uploaded_by_name IS 'Snapshot of the uploading user''s name — survives the user''s deletion.';


--
-- Name: entity_assignees; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.entity_assignees (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    entity_type text NOT NULL,
    entity_id uuid NOT NULL,
    assignee_type text NOT NULL,
    user_id uuid,
    supplier_id uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    created_by uuid,
    CONSTRAINT entity_assignees_assignee_type_check CHECK ((assignee_type = ANY (ARRAY['user'::text, 'supplier'::text]))),
    CONSTRAINT entity_assignees_entity_type_check CHECK ((entity_type = ANY (ARRAY['task'::text, 'issue'::text]))),
    CONSTRAINT entity_assignees_one_target CHECK ((((assignee_type = 'user'::text) AND (user_id IS NOT NULL) AND (supplier_id IS NULL)) OR ((assignee_type = 'supplier'::text) AND (supplier_id IS NOT NULL) AND (user_id IS NULL))))
);


--
-- Name: fin_categories; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.fin_categories (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    kind text NOT NULL,
    name text NOT NULL,
    sort_order integer DEFAULT 0 NOT NULL,
    is_active boolean DEFAULT true NOT NULL,
    is_hot_water boolean DEFAULT false NOT NULL,
    section text DEFAULT 'operating'::text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    created_by uuid,
    CONSTRAINT fin_categories_kind_check CHECK ((kind = ANY (ARRAY['income'::text, 'expense'::text]))),
    CONSTRAINT fin_categories_section_check CHECK ((section = ANY (ARRAY['operating'::text, 'renovation_fund'::text])))
);


--
-- Name: TABLE fin_categories; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.fin_categories IS 'Income/expense categories of the building finance module. Dynamic, start empty (no seed). A category with entries is never deleted — only deactivated.';


--
-- Name: COLUMN fin_categories.is_hot_water; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.fin_categories.is_hot_water IS 'Flags the hot-water category so it can be told apart in reports (no behaviour in slice A).';


--
-- Name: COLUMN fin_categories.section; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.fin_categories.section IS 'operating = the running budget; renovation_fund = קרן שיפוצים, shown apart from the operating totals.';


--
-- Name: fin_documents; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.fin_documents (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    entry_id uuid,
    uploaded_by uuid,
    bucket text DEFAULT 'finance-receipts'::text NOT NULL,
    object_key text NOT NULL,
    original_name text NOT NULL,
    mime text NOT NULL,
    size bigint NOT NULL,
    drive_file_id text,
    drive_status text DEFAULT 'pending'::text NOT NULL,
    drive_error text,
    drive_attempts integer DEFAULT 0 NOT NULL,
    object_deleted_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT fin_documents_drive_status_check CHECK ((drive_status = ANY (ARRAY['pending'::text, 'done'::text, 'failed'::text]))),
    CONSTRAINT fin_documents_size_check CHECK ((size > 0))
);


--
-- Name: TABLE fin_documents; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.fin_documents IS 'Receipts/invoices attached to a fin_entries row. entry_id NULL = uploaded but not yet saved with an entry (staged by uploaded_by). Each file is backed up to Google Drive in the background: drive_status pending → done | failed, up to 5 attempts.';


--
-- Name: COLUMN fin_documents.object_key; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.fin_documents.object_key IS 'Storage key in `bucket` (finance-receipts, private) — <uuid>.<ext>, ASCII only. The readable name is original_name.';


--
-- Name: COLUMN fin_documents.object_deleted_at; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.fin_documents.object_deleted_at IS 'Stamped by the Storage GC when it removed an abandoned staged object. Non-null = the bytes are gone.';


--
-- Name: fin_drive_connection; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.fin_drive_connection (
    id smallint DEFAULT 1 NOT NULL,
    email text NOT NULL,
    refresh_token_enc jsonb NOT NULL,
    root_folder_id text,
    connected_at timestamp with time zone DEFAULT now() NOT NULL,
    connected_by uuid,
    CONSTRAINT fin_drive_connection_single_row CHECK ((id = 1))
);


--
-- Name: TABLE fin_drive_connection; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.fin_drive_connection IS 'The ONE Google account whose Drive receives the receipt backups (scope drive.file). refresh_token_enc = AES-256-GCM blob {iv,ct,tag} under SETTINGS_ENC_KEY (src/lib/crypto/settings-cipher.ts). root_folder_id caches the id of the "ALMOG — קבלות" folder.';


--
-- Name: fin_entries; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.fin_entries (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    kind text NOT NULL,
    category_id uuid NOT NULL,
    period_month date NOT NULL,
    amount numeric(12,2) NOT NULL,
    description text DEFAULT ''::text NOT NULL,
    internal_note text DEFAULT ''::text NOT NULL,
    supplier_id uuid,
    supplier_name text DEFAULT ''::text NOT NULL,
    invoice_number text DEFAULT ''::text NOT NULL,
    payment_date date,
    source text DEFAULT 'manual'::text NOT NULL,
    created_by uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_by uuid,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    deleted_at timestamp with time zone,
    deleted_by uuid,
    CONSTRAINT fin_entries_amount_check CHECK ((amount > (0)::numeric)),
    CONSTRAINT fin_entries_expense_payment_date_check CHECK (((kind = 'income'::text) OR (payment_date IS NOT NULL))),
    CONSTRAINT fin_entries_kind_check CHECK ((kind = ANY (ARRAY['income'::text, 'expense'::text]))),
    CONSTRAINT fin_entries_period_month_check CHECK ((period_month = (date_trunc('month'::text, (period_month)::timestamp with time zone))::date)),
    CONSTRAINT fin_entries_source_check CHECK ((source = ANY (ARRAY['manual'::text, 'ledger_import'::text, 'scan'::text])))
);


--
-- Name: TABLE fin_entries; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.fin_entries IS 'One income or expense line of the building, entered per month. Soft-deleted (deleted_at/deleted_by); an expense counts in full in the month of payment_date (period_month is derived from it).';


--
-- Name: COLUMN fin_entries.period_month; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.fin_entries.period_month IS 'The first day of the month the line belongs to. For an expense it is derived from payment_date; for an income it is the month the operator picked.';


--
-- Name: COLUMN fin_entries.description; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.fin_entries.description IS 'The text a resident will see in the future portal (with the category and the amount).';


--
-- Name: COLUMN fin_entries.internal_note; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.fin_entries.internal_note IS 'Internal only — never shown to residents.';


--
-- Name: COLUMN fin_entries.supplier_name; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.fin_entries.supplier_name IS 'Internal only (never shown to residents). Copied from suppliers.display_name when supplier_id is set, or free text when the supplier is not in the table.';


--
-- Name: COLUMN fin_entries.source; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.fin_entries.source IS 'manual (this slice) | ledger_import | scan — the later slices write the other two.';


--
-- Name: fin_settings; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.fin_settings (
    id smallint DEFAULT 1 NOT NULL,
    show_documents_to_residents boolean DEFAULT false NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_by uuid,
    show_bank_balance_to_residents boolean DEFAULT false NOT NULL,
    CONSTRAINT fin_settings_single_row CHECK ((id = 1))
);


--
-- Name: TABLE fin_settings; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.fin_settings IS 'Single-row settings of the finance module. show_documents_to_residents is persisted here (default OFF) and enforced only by the future owners portal.';


--
-- Name: finance_month_status; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.finance_month_status (
    year integer NOT NULL,
    month integer NOT NULL,
    published boolean DEFAULT false NOT NULL,
    published_at timestamp with time zone,
    published_by uuid,
    bank_balance numeric(12,2),
    bank_balance_updated_at timestamp with time zone,
    bank_balance_updated_by uuid,
    CONSTRAINT finance_month_status_month_check CHECK (((month >= 1) AND (month <= 12))),
    CONSTRAINT finance_month_status_year_check CHECK (((year >= 2000) AND (year <= 2100)))
);


--
-- Name: TABLE finance_month_status; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.finance_month_status IS 'Per-month resident visibility of the finance module. No row = not published. published_at / published_by record the LAST toggle (either direction).';


--
-- Name: COLUMN finance_month_status.bank_balance; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.finance_month_status.bank_balance IS 'Bank balance at the end of the month, entered by hand on /finance. NULL = not entered. Shown to residents only while fin_settings.show_bank_balance_to_residents is on.';


--
-- Name: import_runs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.import_runs (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    started_at timestamp with time zone DEFAULT now() NOT NULL,
    finished_at timestamp with time zone,
    mode text NOT NULL,
    status text DEFAULT 'running'::text NOT NULL,
    total_rows integer DEFAULT 0 NOT NULL,
    processed_rows integer DEFAULT 0 NOT NULL,
    updated_rows integer DEFAULT 0 NOT NULL,
    created_rows integer DEFAULT 0 NOT NULL,
    skipped_rows integer DEFAULT 0 NOT NULL,
    error_message text,
    initiated_by uuid,
    kind text DEFAULT 'debtors'::text NOT NULL,
    file_name text,
    failed_rows integer DEFAULT 0 NOT NULL,
    error_details jsonb,
    error_summary text,
    CONSTRAINT import_runs_kind_check CHECK ((kind = ANY (ARRAY['debtors'::text, 'contacts'::text, 'residents'::text]))),
    CONSTRAINT import_runs_mode_check CHECK ((mode = ANY (ARRAY['merge'::text, 'replace'::text]))),
    CONSTRAINT import_runs_status_check CHECK ((status = ANY (ARRAY['running'::text, 'success'::text, 'error'::text, 'parsing'::text, 'processing'::text, 'completed'::text, 'partial'::text, 'failed'::text])))
);


--
-- Name: internal_conversation_participants; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.internal_conversation_participants (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    conversation_id uuid NOT NULL,
    user_id uuid NOT NULL,
    last_read_at timestamp with time zone DEFAULT now() NOT NULL,
    joined_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: internal_conversations; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.internal_conversations (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    type text DEFAULT 'direct'::text NOT NULL,
    name text,
    created_by uuid,
    created_by_name text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT internal_conversations_type_check CHECK ((type = ANY (ARRAY['direct'::text, 'group'::text])))
);


--
-- Name: internal_messages; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.internal_messages (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    conversation_id uuid NOT NULL,
    sender_user_id uuid,
    sender_name text,
    content text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT internal_messages_content_check CHECK (((char_length(content) >= 1) AND (char_length(content) <= 4000)))
);


--
-- Name: issue_comments; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.issue_comments (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    issue_id uuid NOT NULL,
    content text NOT NULL,
    author_id uuid,
    author_name text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: issues; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.issues (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    title text NOT NULL,
    description text,
    location_type text DEFAULT 'general'::text NOT NULL,
    location_text text,
    priority text DEFAULT 'normal'::text NOT NULL,
    status text DEFAULT 'open'::text NOT NULL,
    assigned_to_user_id uuid,
    images text[] DEFAULT '{}'::text[] NOT NULL,
    resolution_notes text,
    resolved_at timestamp with time zone,
    is_archived boolean DEFAULT false NOT NULL,
    created_by uuid,
    created_by_name text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    target_type text,
    target_id uuid,
    supplier_id uuid,
    sort_order integer DEFAULT 0 NOT NULL,
    due_date date,
    due_time time without time zone,
    videos text[] DEFAULT '{}'::text[] NOT NULL,
    source text DEFAULT 'staff'::text NOT NULL,
    reporter_contact_id uuid,
    reporter_name text,
    reporter_phone text,
    reporter_apartment text,
    reporter_location text,
    reporter_area text,
    ticket_number integer,
    reporter_role text,
    board_column text,
    CONSTRAINT issues_board_column_check CHECK (((board_column IS NULL) OR (board_column = ANY (ARRAY['awaiting'::text, 'today'::text, 'in_progress'::text])))),
    CONSTRAINT issues_location_type_check CHECK ((location_type = ANY (ARRAY['apartment'::text, 'area'::text, 'general'::text]))),
    CONSTRAINT issues_portal_reporter_check CHECK (((source <> 'portal'::text) OR ((reporter_phone IS NOT NULL) AND (reporter_location IS NOT NULL) AND (ticket_number IS NOT NULL) AND ((reporter_apartment IS NULL) OR (btrim(reporter_apartment) <> ''::text)) AND ((reporter_contact_id IS NULL) OR (reporter_apartment IS NOT NULL))))),
    CONSTRAINT issues_priority_check CHECK ((priority = ANY (ARRAY['low'::text, 'normal'::text, 'high'::text, 'urgent'::text]))),
    CONSTRAINT issues_reporter_phone_e164_check CHECK (((reporter_phone IS NULL) OR (reporter_phone ~ '^\+[1-9][0-9]{6,14}$'::text))),
    CONSTRAINT issues_reporter_role_check CHECK (((reporter_role IS NULL) OR (reporter_role = ANY (ARRAY['owner'::text, 'tenant'::text, 'operator'::text])))),
    CONSTRAINT issues_source_check CHECK ((source = ANY (ARRAY['staff'::text, 'portal'::text]))),
    CONSTRAINT issues_status_check CHECK ((status = ANY (ARRAY['open'::text, 'in_progress'::text, 'resolved'::text, 'closed'::text]))),
    CONSTRAINT issues_target_type_check CHECK ((target_type = ANY (ARRAY['room'::text, 'area'::text])))
);


--
-- Name: COLUMN issues.sort_order; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.issues.sort_order IS 'Order inside the issue''s kanban column, ascending (spaced by 1024). A new issue goes above every existing one.';


--
-- Name: COLUMN issues.source; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.issues.source IS 'Who opened the issue: staff (the issues screen) or portal (an owner, through /portal/report).';


--
-- Name: COLUMN issues.reporter_contact_id; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.issues.reporter_contact_id IS 'Portal reports: the apartment_owner_phones row (phone + apartment) that signed in. Pointer only — the reporter_* snapshot is the record.';


--
-- Name: COLUMN issues.reporter_phone; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.issues.reporter_phone IS 'Portal reports: the reporter''s phone at report time, E.164, from the portal session. Served only to staff with contacts:view.';


--
-- Name: COLUMN issues.reporter_apartment; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.issues.reporter_apartment IS 'Portal reports: the reporter''s apartment at report time (the lowest-numbered apartment of the phone).';


--
-- Name: COLUMN issues.reporter_location; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.issues.reporter_location IS 'Portal reports: "מיקום" as the resident typed it.';


--
-- Name: COLUMN issues.reporter_area; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.issues.reporter_area IS 'Portal reports: "קומה / אזור" as the resident typed it (optional).';


--
-- Name: COLUMN issues.ticket_number; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.issues.ticket_number IS 'Portal reports: the call number shown to the resident (issues_ticket_number_seq, from 1001).';


--
-- Name: COLUMN issues.reporter_role; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.issues.reporter_role IS 'source=portal: the role the reporter held in reporter_apartment when reporting (owner · tenant · operator). NULL for an unidentified reporter and for staff issues.';


--
-- Name: COLUMN issues.board_column; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.issues.board_column IS 'Kanban column on /issues (awaiting · today · in_progress), set at insert from the computed rule and afterwards only by a drag (PATCH /api/issues/[id]/move). NULL = computed live (lib/issues/board.ts). Resolved / closed issues show in "בוצע" whatever this says.';


--
-- Name: CONSTRAINT issues_portal_reporter_check ON issues; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON CONSTRAINT issues_portal_reporter_check ON public.issues IS 'Portal rows carry the reporter snapshot. reporter_apartment may be NULL only for an unidentified reporter (reporter_contact_id NULL — a phone whose apartments belong to different people); never ''''.';


--
-- Name: issues_sort_order_backup; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.issues_sort_order_backup (
    issue_id uuid NOT NULL,
    sort_order integer NOT NULL,
    backed_up_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: TABLE issues_sort_order_backup; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.issues_sort_order_backup IS 'issues.sort_order before the manual kanban (04/10/2026). Rollback source for migration 20261004180139; safe to drop once the board is confirmed.';


--
-- Name: issues_ticket_number_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.issues_ticket_number_seq
    AS integer
    START WITH 1001
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: issues_ticket_number_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.issues_ticket_number_seq OWNED BY public.issues.ticket_number;


--
-- Name: legal_status_history; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.legal_status_history (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    debtor_id uuid NOT NULL,
    apartment_number text NOT NULL,
    old_status_id uuid,
    old_status_name text,
    new_status_id uuid,
    new_status_name text,
    changed_at timestamp with time zone DEFAULT now() NOT NULL,
    changed_by uuid,
    changed_by_name text,
    source text DEFAULT 'MANUAL'::text NOT NULL,
    notes text,
    CONSTRAINT legal_status_history_source_check CHECK ((source = ANY (ARRAY['MANUAL'::text, 'IMPORT'::text, 'AUTO_DEFAULT'::text, 'SYSTEM_FIX'::text])))
);


--
-- Name: monthly_collections; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.monthly_collections (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    year integer NOT NULL,
    month integer NOT NULL,
    collected_amount numeric(12,2) DEFAULT 0 NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT monthly_collections_month_check CHECK (((month >= 1) AND (month <= 12)))
);


--
-- Name: monthly_debt_snapshots; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.monthly_debt_snapshots (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    snapshot_year integer NOT NULL,
    snapshot_month integer NOT NULL,
    snapshot_date date NOT NULL,
    total_debt numeric(12,2) DEFAULT 0 NOT NULL,
    management_debt numeric(12,2) DEFAULT 0 NOT NULL,
    water_debt numeric(12,2) DEFAULT 0 NOT NULL,
    special_debt numeric(12,2) DEFAULT 0 NOT NULL,
    debtor_count integer DEFAULT 0 NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT monthly_debt_snapshots_snapshot_month_check CHECK (((snapshot_month >= 1) AND (snapshot_month <= 12)))
);


--
-- Name: notifications; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.notifications (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid NOT NULL,
    type text NOT NULL,
    title text NOT NULL,
    message text,
    is_read boolean DEFAULT false NOT NULL,
    source_module text,
    source_entity_type text,
    source_entity_id uuid,
    action_url text,
    priority text DEFAULT 'normal'::text NOT NULL,
    dedupe_key text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    read_at timestamp with time zone,
    cleared_at timestamp with time zone,
    CONSTRAINT notifications_priority_check CHECK ((priority = ANY (ARRAY['low'::text, 'normal'::text, 'high'::text, 'urgent'::text])))
);


--
-- Name: parking_spots; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.parking_spots (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    lot_code text DEFAULT '1P'::text NOT NULL,
    spot_number integer NOT NULL,
    size_type text DEFAULT 'single'::text NOT NULL,
    capacity integer GENERATED ALWAYS AS (
CASE
    WHEN (size_type = 'single'::text) THEN 1
    ELSE 2
END) STORED,
    owner_type text NOT NULL,
    apartment_number text,
    sale_status text DEFAULT 'none'::text NOT NULL,
    notes text,
    is_active boolean DEFAULT true NOT NULL,
    deactivated_at timestamp with time zone,
    deactivated_by uuid,
    deactivation_reason text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    created_by uuid,
    updated_by uuid,
    CONSTRAINT parking_spots_apartment_link_check CHECK (((owner_type = 'apartment'::text) = (apartment_number IS NOT NULL))),
    CONSTRAINT parking_spots_deactivation_reason_required CHECK ((is_active OR (deactivation_reason IS NOT NULL))),
    CONSTRAINT parking_spots_owner_type_check CHECK ((owner_type = ANY (ARRAY['apartment'::text, 'developer'::text, 'committee'::text]))),
    CONSTRAINT parking_spots_sale_status_check CHECK ((sale_status = ANY (ARRAY['none'::text, 'for_sale'::text, 'in_process'::text, 'sold'::text]))),
    CONSTRAINT parking_spots_size_type_check CHECK ((size_type = ANY (ARRAY['single'::text, 'double_width'::text, 'double_length'::text])))
);


--
-- Name: password_reset_tokens; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.password_reset_tokens (
    token text NOT NULL,
    user_id uuid NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    used_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: portal_decisions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.portal_decisions (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    title text NOT NULL,
    summary text,
    doc_type text NOT NULL,
    decision_number text,
    decided_at date NOT NULL,
    bucket text DEFAULT 'portal-decisions'::text NOT NULL,
    object_key text NOT NULL,
    original_filename text NOT NULL,
    file_size bigint NOT NULL,
    mime_type text NOT NULL,
    published boolean DEFAULT true NOT NULL,
    created_by uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT portal_decisions_doc_type_check CHECK ((doc_type = ANY (ARRAY['decision'::text, 'protocol'::text]))),
    CONSTRAINT portal_decisions_file_size_check CHECK ((file_size > 0)),
    CONSTRAINT portal_decisions_number_length CHECK (((decision_number IS NULL) OR ((char_length(decision_number) >= 1) AND (char_length(decision_number) <= 40)))),
    CONSTRAINT portal_decisions_summary_length CHECK (((summary IS NULL) OR (char_length(summary) <= 2000))),
    CONSTRAINT portal_decisions_title_length CHECK (((char_length(title) >= 1) AND (char_length(title) <= 200)))
);


--
-- Name: TABLE portal_decisions; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.portal_decisions IS 'House-committee decisions and assembly protocols, one PDF each. Managed in the CRM (/decisions); the owners portal reads only published rows.';


--
-- Name: COLUMN portal_decisions.doc_type; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.portal_decisions.doc_type IS 'decision = החלטה (may carry decision_number) · protocol = פרוטוקול (never numbered on screen).';


--
-- Name: COLUMN portal_decisions.decision_number; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.portal_decisions.decision_number IS 'Free-form label of a decision, e.g. "14/2026". NULL for a protocol and for an unnumbered decision.';


--
-- Name: COLUMN portal_decisions.object_key; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.portal_decisions.object_key IS 'Storage key in `bucket` (portal-decisions, private) — <uuid>.pdf, ASCII only. The readable name is original_filename.';


--
-- Name: COLUMN portal_decisions.published; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.portal_decisions.published IS 'false = hidden from the portal entirely, list AND file path. The CRM still lists it.';


--
-- Name: portal_identity_apartments; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.portal_identity_apartments (
    approval_id uuid NOT NULL,
    apartment_number text NOT NULL,
    relation text NOT NULL,
    CONSTRAINT portal_identity_apartments_relation_check CHECK ((relation = ANY (ARRAY['personal'::text, 'company_authorized'::text, 'family'::text])))
);


--
-- Name: TABLE portal_identity_apartments; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.portal_identity_apartments IS 'Per apartment of an approved identity: how the person is connected to it — personal (their own), company_authorized (authorised for a company), family (a relative).';


--
-- Name: portal_identity_approvals; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.portal_identity_approvals (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    phone_e164 text NOT NULL,
    status text NOT NULL,
    display_name text,
    names text[] DEFAULT '{}'::text[] NOT NULL,
    request_source text NOT NULL,
    requested_by uuid,
    requested_at timestamp with time zone DEFAULT now() NOT NULL,
    decided_by uuid,
    decided_at timestamp with time zone,
    ended_by uuid,
    ended_at timestamp with time zone,
    CONSTRAINT portal_identity_approvals_approved_shape_check CHECK (((status <> ALL (ARRAY['approved'::text, 'superseded'::text, 'revoked'::text])) OR ((NULLIF(btrim(COALESCE(display_name, ''::text)), ''::text) IS NOT NULL) AND (decided_at IS NOT NULL)))),
    CONSTRAINT portal_identity_approvals_ended_shape_check CHECK (((status = ANY (ARRAY['superseded'::text, 'revoked'::text, 'rejected'::text])) = (ended_at IS NOT NULL))),
    CONSTRAINT portal_identity_approvals_names_check CHECK ((NOT (''::text = ANY (names)))),
    CONSTRAINT portal_identity_approvals_phone_check CHECK ((phone_e164 ~ '^\+[1-9][0-9]{6,14}$'::text)),
    CONSTRAINT portal_identity_approvals_source_check CHECK ((request_source = ANY (ARRAY['blocked_screen'::text, 'entry_warning'::text]))),
    CONSTRAINT portal_identity_approvals_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'approved'::text, 'superseded'::text, 'revoked'::text, 'rejected'::text])))
);


--
-- Name: TABLE portal_identity_approvals; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.portal_identity_approvals IS 'A person with portal_manage confirmed that one phone, carrying several names, is ONE person. status: pending (asked from the apartment card, waiting) · approved (in force) · superseded (replaced by a newer approval) · revoked · rejected. names = the whitespace-normalised names the approval covers; a name outside it blocks the phone again.';


--
-- Name: portal_lockouts; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.portal_lockouts (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    phone_e164 text NOT NULL,
    locked_until timestamp with time zone NOT NULL,
    tier smallint NOT NULL,
    reason text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    released_by uuid,
    released_at timestamp with time zone,
    CONSTRAINT portal_lockouts_reason_check CHECK ((reason = ANY (ARRAY['too_many_invalid_codes'::text, 'too_many_code_requests'::text]))),
    CONSTRAINT portal_lockouts_tier_check CHECK (((tier >= 1) AND (tier <= 3)))
);


--
-- Name: TABLE portal_lockouts; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.portal_lockouts IS 'Escalating temporary lockouts of a phone: tier 1 = 30 minutes, 2 = 2 hours, 3 = 24 hours. The tier rises when a lockout repeats within 24h. released_by / released_at record a manual "שחרר חסימה" from the apartment card.';


--
-- Name: portal_login_events; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.portal_login_events (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    phone_e164 text NOT NULL,
    apartment_numbers text[] DEFAULT '{}'::text[] NOT NULL,
    event_type text NOT NULL,
    ip text,
    user_agent text,
    details jsonb,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT portal_login_events_event_type_check CHECK ((event_type = ANY (ARRAY['code_requested'::text, 'code_sent'::text, 'send_failed'::text, 'code_invalid'::text, 'code_expired'::text, 'login_success'::text, 'phone_not_found'::text, 'phone_inactive'::text, 'locked_out'::text, 'unlocked_manually'::text, 'session_revoked'::text])))
);


--
-- Name: TABLE portal_login_events; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.portal_login_events IS 'Every portal login attempt, including attempts from a phone that is not on the roster (apartment_numbers stays empty — the admin screen shows "—"). Kept for a year; no automatic purge in this slice. details NEVER contains the code itself.';


--
-- Name: COLUMN portal_login_events.apartment_numbers; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.portal_login_events.apartment_numbers IS 'Every apartment the phone owns at the time of the event. Empty when the phone is unknown. A plain text[] snapshot, not an FK: the log must survive a roster change.';


--
-- Name: portal_otp_codes; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.portal_otp_codes (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    phone_e164 text NOT NULL,
    code_hash text NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    attempts integer DEFAULT 0 NOT NULL,
    consumed_at timestamp with time zone,
    ip text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT portal_otp_codes_attempts_check CHECK ((attempts >= 0))
);


--
-- Name: TABLE portal_otp_codes; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.portal_otp_codes IS 'WhatsApp one-time codes for the owners portal. code_hash is bcrypt of the 6 digits (never the digits themselves, here or in the log). attempts counts wrong guesses against THIS code; consumed_at marks a successful login.';


--
-- Name: portal_phone_entry_flags; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.portal_phone_entry_flags (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    phone_e164 text NOT NULL,
    apartment_number text NOT NULL,
    entered_name text,
    other_apartments text[] DEFAULT '{}'::text[] NOT NULL,
    flagged_by uuid,
    flagged_at timestamp with time zone DEFAULT now() NOT NULL,
    cleared_by uuid,
    cleared_at timestamp with time zone
);


--
-- Name: TABLE portal_phone_entry_flags; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.portal_phone_entry_flags IS 'Someone typed a phone on an apartment card that another apartment already carries under another name, and answered "a different person": a suspected typing mistake. The phone is blocked by the different names; the flag is what the blocked-phones screen shows about it.';


--
-- Name: portal_sessions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.portal_sessions (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    token_hash text NOT NULL,
    phone_e164 text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    revoked_at timestamp with time zone,
    ip text,
    user_agent text
);


--
-- Name: TABLE portal_sessions; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.portal_sessions IS 'Sessions of the owners portal — deliberately NOT public.sessions: a portal session has no users row, and the staff cookie must never open /portal. token_hash is sha256 of the raw token that lives only in the portal_session cookie (same contract as public.sessions.id).';


--
-- Name: reminder_categories; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.reminder_categories (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    name text NOT NULL,
    color text NOT NULL,
    created_by uuid,
    display_order integer DEFAULT 0 NOT NULL,
    is_archived boolean DEFAULT false NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: reminders; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.reminders (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    entity_type text NOT NULL,
    entity_id uuid NOT NULL,
    user_id uuid NOT NULL,
    remind_at timestamp with time zone NOT NULL,
    channel text DEFAULT 'both'::text NOT NULL,
    sent_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    channels text[],
    notify_owner boolean DEFAULT false NOT NULL,
    CONSTRAINT reminders_channel_check CHECK ((channel = ANY (ARRAY['in_app'::text, 'email'::text, 'both'::text, 'whatsapp'::text]))),
    CONSTRAINT reminders_channels_valid CHECK (((channels IS NULL) OR ((array_length(channels, 1) >= 1) AND (channels <@ ARRAY['in_app'::text, 'email'::text, 'whatsapp'::text]))))
);


--
-- Name: COLUMN reminders.notify_owner; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.reminders.notify_owner IS 'When true, the reminder engine also notifies the row owner (user_id) — the "אליי"/self opt-in — in addition to the entity assignees.';


--
-- Name: renovation_fund_settings; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.renovation_fund_settings (
    id smallint DEFAULT 1 NOT NULL,
    target_amount numeric(12,2) DEFAULT 0 NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_by uuid,
    CONSTRAINT renovation_fund_settings_single_row CHECK ((id = 1)),
    CONSTRAINT renovation_fund_settings_target_check CHECK ((target_amount >= (0)::numeric))
);


--
-- Name: TABLE renovation_fund_settings; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.renovation_fund_settings IS 'Single row: the renovation fund collection target (יעד גבייה) the cumulative KPI is measured against.';


--
-- Name: schema_migrations; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.schema_migrations (
    version character varying NOT NULL
);


--
-- Name: sessions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.sessions (
    id text NOT NULL,
    user_id uuid NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    remember boolean DEFAULT false NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: statuses; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.statuses (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    name text NOT NULL,
    description text,
    color text DEFAULT '#e5e7eb'::text NOT NULL,
    is_default boolean DEFAULT false NOT NULL,
    is_active boolean DEFAULT true NOT NULL,
    sort_order integer DEFAULT 0 NOT NULL,
    notification_emails text[],
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    is_system boolean DEFAULT false NOT NULL,
    created_by uuid,
    updated_by uuid,
    CONSTRAINT statuses_color_format CHECK ((color ~ '^#[0-9a-fA-F]{6}$'::text))
);


--
-- Name: storage_cleanup_runs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.storage_cleanup_runs (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    started_at timestamp with time zone DEFAULT now() NOT NULL,
    finished_at timestamp with time zone,
    mode text DEFAULT 'dry_run'::text NOT NULL,
    status text DEFAULT 'running'::text NOT NULL,
    error_stage text,
    error_message text,
    objects_scanned integer DEFAULT 0 NOT NULL,
    objects_deleted integer DEFAULT 0 NOT NULL,
    bytes_deleted bigint DEFAULT 0 NOT NULL,
    buckets_blocked integer DEFAULT 0 NOT NULL,
    summary jsonb,
    CONSTRAINT storage_cleanup_runs_error_stage_check CHECK (((error_stage IS NULL) OR (error_stage = ANY (ARRAY['connect'::text, 'list'::text, 'cross_reference'::text, 'delete'::text, 'record'::text])))),
    CONSTRAINT storage_cleanup_runs_mode_check CHECK ((mode = ANY (ARRAY['dry_run'::text, 'apply'::text]))),
    CONSTRAINT storage_cleanup_runs_status_check CHECK ((status = ANY (ARRAY['running'::text, 'success'::text, 'error'::text])))
);


--
-- Name: TABLE storage_cleanup_runs; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.storage_cleanup_runs IS 'One row per Storage GC run (scripts/storage-cleanup.ts). summary = the exact per-bucket plan, including every key the run resolved and any bucket the safety brake blocked.';


--
-- Name: COLUMN storage_cleanup_runs.mode; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.storage_cleanup_runs.mode IS 'dry_run = resolved and recorded but deleted nothing (the default, and what the timer runs until phase 3); apply = actually removed the objects.';


--
-- Name: COLUMN storage_cleanup_runs.buckets_blocked; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.storage_cleanup_runs.buckets_blocked IS 'Buckets the safety brake refused: more than 20% of the bucket selected for deletion, or the DB produced no pointers at all for a non-empty bucket (the signature of a broken cross-reference query).';


--
-- Name: storage_units; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.storage_units (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    unit_number text NOT NULL,
    owner_type text NOT NULL,
    apartment_number text,
    notes text,
    is_active boolean DEFAULT true NOT NULL,
    deactivated_at timestamp with time zone,
    deactivated_by uuid,
    deactivation_reason text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    created_by uuid,
    updated_by uuid,
    CONSTRAINT storage_units_apartment_link_check CHECK (((owner_type = 'apartment'::text) = (apartment_number IS NOT NULL))),
    CONSTRAINT storage_units_deactivation_reason_required CHECK ((is_active OR (deactivation_reason IS NOT NULL))),
    CONSTRAINT storage_units_owner_type_check CHECK ((owner_type = ANY (ARRAY['apartment'::text, 'developer'::text, 'committee'::text])))
);


--
-- Name: supplier_categories; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.supplier_categories (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    name text NOT NULL,
    is_active boolean DEFAULT true NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    color text
);


--
-- Name: supplier_contacts; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.supplier_contacts (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    supplier_id uuid NOT NULL,
    name text DEFAULT ''::text NOT NULL,
    phone text DEFAULT ''::text NOT NULL,
    email text DEFAULT ''::text NOT NULL,
    sort_order integer DEFAULT 0 NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: TABLE supplier_contacts; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.supplier_contacts IS 'Additional contact people of a supplier (the primary one stays in suppliers.contact_person). The supplier panel replaces the whole list on save; sort_order = panel order.';


--
-- Name: COLUMN supplier_contacts.phone; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.supplier_contacts.phone IS 'Mobile phone (טלפון נייד), stored as cleanPhoneField returns it.';


--
-- Name: supplier_documents; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.supplier_documents (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    supplier_id uuid NOT NULL,
    file_name text NOT NULL,
    file_url text NOT NULL,
    file_size_bytes integer DEFAULT 0 NOT NULL,
    mime_type text DEFAULT ''::text NOT NULL,
    doc_type text DEFAULT 'general'::text NOT NULL,
    uploaded_by uuid,
    uploaded_by_name text,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: suppliers; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.suppliers (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    display_name text NOT NULL,
    company_name text DEFAULT ''::text NOT NULL,
    contact_person text DEFAULT ''::text NOT NULL,
    supplier_type text DEFAULT 'general'::text NOT NULL,
    status text DEFAULT 'active'::text NOT NULL,
    phone text DEFAULT ''::text NOT NULL,
    mobile text DEFAULT ''::text NOT NULL,
    email text DEFAULT ''::text NOT NULL,
    website text DEFAULT ''::text NOT NULL,
    address text DEFAULT ''::text NOT NULL,
    city text DEFAULT ''::text NOT NULL,
    tax_id text DEFAULT ''::text NOT NULL,
    bank_name text DEFAULT ''::text NOT NULL,
    bank_branch text DEFAULT ''::text NOT NULL,
    bank_account text DEFAULT ''::text NOT NULL,
    payment_terms text DEFAULT 'net_30'::text NOT NULL,
    notes text DEFAULT ''::text NOT NULL,
    internal_notes text DEFAULT ''::text NOT NULL,
    rating integer,
    created_by uuid,
    created_by_name text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    deleted_at timestamp with time zone,
    category_id uuid,
    CONSTRAINT suppliers_payment_terms_check CHECK ((payment_terms = ANY (ARRAY['immediate'::text, 'net_15'::text, 'net_30'::text, 'net_45'::text, 'net_60'::text, 'net_90'::text, 'other'::text]))),
    CONSTRAINT suppliers_status_check CHECK ((status = ANY (ARRAY['active'::text, 'archived'::text])))
);


--
-- Name: sync_runs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.sync_runs (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    started_at timestamp with time zone DEFAULT now() NOT NULL,
    finished_at timestamp with time zone,
    status text DEFAULT 'running'::text NOT NULL,
    error_message text,
    triggered_by uuid,
    error_stage text,
    source_run_at timestamp with time zone,
    rows_count integer,
    import_run_id uuid,
    trigger_source text DEFAULT 'ui'::text NOT NULL,
    CONSTRAINT sync_runs_error_stage_check CHECK (((error_stage IS NULL) OR (error_stage = ANY (ARRAY['scrape'::text, 'stale'::text, 'guard'::text, 'pull'::text, 'reconcile'::text])))),
    CONSTRAINT sync_runs_status_check CHECK ((status = ANY (ARRAY['running'::text, 'success'::text, 'error'::text]))),
    CONSTRAINT sync_runs_trigger_source_check CHECK ((trigger_source = ANY (ARRAY['ui'::text, 'cron'::text])))
);


--
-- Name: COLUMN sync_runs.error_stage; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.sync_runs.error_stage IS 'Stage that failed: scrape (Bllink download), stale (snapshot older than the freshness limit), guard (pre-write completeness/consistency of the snapshot), pull (fetch or write), reconcile (post-write: debtors sums per category or per apartment differ from the report)';


--
-- Name: COLUMN sync_runs.source_run_at; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.sync_runs.source_run_at IS 'last_import_at of the CRM snapshot this run read — the moment Bllink was actually scraped; the dashboard shows this, not the copy time';


--
-- Name: COLUMN sync_runs.rows_count; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.sync_runs.rows_count IS 'Apartments written by a successful run';


--
-- Name: COLUMN sync_runs.trigger_source; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.sync_runs.trigger_source IS 'ui = "סנכרן עכשיו" button (triggered_by set) · cron = billing-sync.timer via x-cron-secret (triggered_by null)';


--
-- Name: task_comments; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.task_comments (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    task_id uuid NOT NULL,
    content text NOT NULL,
    author_id uuid,
    author_name text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: task_occurrence_completions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.task_occurrence_completions (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    task_id uuid NOT NULL,
    recurrence_id uuid,
    occurrence_date date NOT NULL,
    completed_at timestamp with time zone DEFAULT now() NOT NULL,
    completed_by uuid,
    completed_by_name text
);


--
-- Name: task_recurrence_exceptions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.task_recurrence_exceptions (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    recurrence_id uuid NOT NULL,
    excluded_date date NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: task_recurrences; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.task_recurrences (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    task_id uuid NOT NULL,
    is_active boolean DEFAULT true NOT NULL,
    frequency text NOT NULL,
    "interval" integer DEFAULT 1 NOT NULL,
    byweekday integer[],
    end_type text DEFAULT 'never'::text NOT NULL,
    end_date date,
    end_count integer,
    last_spawned_at timestamp with time zone,
    spawned_count integer DEFAULT 0 NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    anchor_date date NOT NULL,
    CONSTRAINT task_recurrences_end_count_check CHECK (((end_count IS NULL) OR (end_count >= 1))),
    CONSTRAINT task_recurrences_end_type_check CHECK ((end_type = ANY (ARRAY['never'::text, 'on_date'::text, 'after_count'::text]))),
    CONSTRAINT task_recurrences_frequency_check CHECK ((frequency = ANY (ARRAY['daily'::text, 'weekly'::text, 'monthly'::text, 'yearly'::text]))),
    CONSTRAINT task_recurrences_interval_check CHECK (("interval" >= 1))
);


--
-- Name: COLUMN task_recurrences.last_spawned_at; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.task_recurrences.last_spawned_at IS 'FROZEN (migration 067): the materializer is gone.';


--
-- Name: COLUMN task_recurrences.spawned_count; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.task_recurrences.spawned_count IS 'FROZEN (migration 067): the materializer is gone.';


--
-- Name: COLUMN task_recurrences.anchor_date; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.task_recurrences.anchor_date IS 'Series origin (immutable). interval / after_count are measured from here, so advancing tasks.due_date never re-phases the series.';


--
-- Name: tasks; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.tasks (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    title text NOT NULL,
    description text,
    status text DEFAULT 'open'::text NOT NULL,
    priority text DEFAULT 'normal'::text NOT NULL,
    due_date date,
    due_time time without time zone,
    assigned_to_user_id uuid,
    debtor_id uuid,
    apartment_number text,
    sort_order integer DEFAULT 0 NOT NULL,
    is_archived boolean DEFAULT false NOT NULL,
    created_by uuid,
    created_by_name text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    issue_id uuid,
    completed_at timestamp with time zone,
    related_entity_type text,
    related_entity_id uuid,
    target_type text,
    target_id uuid,
    supplier_id uuid,
    recurrence_id uuid,
    is_recurring_template boolean DEFAULT false NOT NULL,
    is_recurring_instance boolean DEFAULT false NOT NULL,
    parent_task_id uuid,
    occurrence_date date,
    CONSTRAINT tasks_priority_check CHECK ((priority = ANY (ARRAY['low'::text, 'normal'::text, 'high'::text, 'urgent'::text]))),
    CONSTRAINT tasks_related_entity_type_check CHECK ((related_entity_type = ANY (ARRAY['debtor'::text, 'building'::text, 'supplier'::text, 'contact'::text]))),
    CONSTRAINT tasks_status_check CHECK ((status = ANY (ARRAY['open'::text, 'in_progress'::text, 'done'::text, 'cancelled'::text]))),
    CONSTRAINT tasks_target_type_check CHECK ((target_type = ANY (ARRAY['room'::text, 'area'::text])))
);


--
-- Name: COLUMN tasks.is_recurring_instance; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.tasks.is_recurring_instance IS 'FROZEN (migration 067): always false — there are no materialized instances any more.';


--
-- Name: COLUMN tasks.parent_task_id; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.tasks.parent_task_id IS 'FROZEN (migration 067): instances no longer exist, so nothing points at a parent task.';


--
-- Name: COLUMN tasks.occurrence_date; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.tasks.occurrence_date IS 'FROZEN (migration 067): superseded by the single-row model — due_date is the current occurrence.';


--
-- Name: user_invites; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.user_invites (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    email text NOT NULL,
    full_name text NOT NULL,
    role text NOT NULL,
    token text NOT NULL,
    invited_by uuid,
    expires_at timestamp with time zone NOT NULL,
    accepted_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    custom_permissions jsonb,
    CONSTRAINT user_invites_role_check CHECK ((role = ANY (ARRAY['super_admin'::text, 'admin'::text, 'manager'::text, 'viewer'::text, 'cleaner'::text, 'maintenance'::text])))
);


--
-- Name: user_permissions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.user_permissions (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid NOT NULL,
    module text NOT NULL,
    can_view boolean DEFAULT false NOT NULL,
    can_edit boolean DEFAULT false NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: user_reminder_attachments; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.user_reminder_attachments (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    reminder_id uuid,
    uploaded_by uuid,
    bucket text DEFAULT 'reminder-attachments'::text NOT NULL,
    object_key text NOT NULL,
    original_name text NOT NULL,
    mime text NOT NULL,
    size bigint NOT NULL,
    object_deleted_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT user_reminder_attachments_size_check CHECK ((size > 0))
);


--
-- Name: TABLE user_reminder_attachments; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.user_reminder_attachments IS 'Files attached to a user_reminders row. reminder_id NULL = uploaded but not yet saved with a reminder (staged by uploaded_by). Same lifecycle as fin_documents.';


--
-- Name: COLUMN user_reminder_attachments.object_key; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.user_reminder_attachments.object_key IS 'Storage key in `bucket` (reminder-attachments, private) — <uuid>.<ext>, ASCII only. The readable name is original_name.';


--
-- Name: COLUMN user_reminder_attachments.object_deleted_at; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.user_reminder_attachments.object_deleted_at IS 'Stamped by the Storage GC when it removed an abandoned staged object. Non-null = the bytes are gone.';


--
-- Name: user_reminder_order; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.user_reminder_order (
    user_id uuid NOT NULL,
    reminder_id uuid NOT NULL,
    "position" integer NOT NULL
);


--
-- Name: TABLE user_reminder_order; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.user_reminder_order IS 'Where each user placed each reminder in their own list (drag order, 06/10/2026). Per user: one person''s drag never moves another''s list. No row = after every placed one, by remind_at.';


--
-- Name: COLUMN user_reminder_order."position"; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.user_reminder_order."position" IS 'Ascending place in that user''s list; rewritten 0..n-1 for the ids of the tab the user dragged in.';


--
-- Name: user_reminders; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.user_reminders (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    title text NOT NULL,
    remind_at timestamp with time zone NOT NULL,
    status text DEFAULT 'pending'::text NOT NULL,
    entity_type text,
    entity_id text,
    assigned_to uuid,
    created_by uuid,
    completed_at timestamp with time zone,
    is_archived boolean DEFAULT false NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    category_id uuid,
    description text,
    created_by_name text,
    CONSTRAINT user_reminders_description_length CHECK (((description IS NULL) OR (char_length(description) <= 1000))),
    CONSTRAINT user_reminders_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'done'::text, 'dismissed'::text])))
);


--
-- Name: COLUMN user_reminders.description; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.user_reminders.description IS 'Optional free text under the title (up to 1000 characters). NULL = none.';


--
-- Name: COLUMN user_reminders.created_by_name; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.user_reminders.created_by_name IS 'Snapshot of the creating user''s name — survives the user''s deletion (the assignee sees who wrote the reminder).';


--
-- Name: users; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.users (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    username text NOT NULL,
    email text NOT NULL,
    password_hash text NOT NULL,
    full_name text,
    is_active boolean DEFAULT true NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    role text DEFAULT 'viewer'::text NOT NULL,
    notification_phone text,
    notify_email boolean DEFAULT true NOT NULL,
    notify_whatsapp boolean DEFAULT false NOT NULL,
    allow_google_auth boolean DEFAULT false NOT NULL,
    last_seen_at timestamp with time zone,
    CONSTRAINT users_role_check CHECK ((role = ANY (ARRAY['super_admin'::text, 'admin'::text, 'manager'::text, 'viewer'::text, 'cleaner'::text, 'maintenance'::text])))
);


--
-- Name: COLUMN users.last_seen_at; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.users.last_seen_at IS 'Last realtime-chat heartbeat (SSE connect/heartbeat). Drives the online dot: online = now() - last_seen_at < 60s.';


--
-- Name: wa_campaign_attachments; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.wa_campaign_attachments (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    campaign_id uuid,
    uploaded_by uuid,
    bucket text NOT NULL,
    object_key text NOT NULL,
    original_name text NOT NULL,
    mime_type text NOT NULL,
    size_bytes bigint NOT NULL,
    sort_order integer DEFAULT 0 NOT NULL,
    green_api_url text,
    green_api_url_expires_at timestamp with time zone,
    green_api_error text,
    green_api_upload_attempts integer DEFAULT 0 NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    object_deleted_at timestamp with time zone,
    CONSTRAINT wa_campaign_attachments_size_bytes_check CHECK ((size_bytes > 0))
);


--
-- Name: TABLE wa_campaign_attachments; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.wa_campaign_attachments IS 'Files attached to a WhatsApp broadcast (wa_campaigns). campaign_id NULL = uploaded but not yet submitted. green_api_url = Green API uploadFile link (15 days), reused for every recipient via sendFileByUrl.';


--
-- Name: COLUMN wa_campaign_attachments.object_key; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.wa_campaign_attachments.object_key IS 'Storage key in `bucket` — <uuid>.<ext>, ASCII only. The readable name is original_name.';


--
-- Name: COLUMN wa_campaign_attachments.green_api_upload_attempts; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.wa_campaign_attachments.green_api_upload_attempts IS 'uploadFile attempts by the worker; after 3 failures the worker falls back to sendFileByUpload per recipient.';


--
-- Name: COLUMN wa_campaign_attachments.object_deleted_at; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.wa_campaign_attachments.object_deleted_at IS 'Set by scripts/storage-cleanup.ts when it removed this row''s object from Storage as `staged_old` (unbound and >24h old). The row survives as the record of the upload; the staged lookups skip it so the file can never be attached to a new broadcast. NULL = the object is still there.';


--
-- Name: wa_campaign_recipient_apartments; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.wa_campaign_recipient_apartments (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    recipient_id uuid NOT NULL,
    contact_id uuid NOT NULL,
    debtor_id uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: wa_campaign_recipients; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.wa_campaign_recipients (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    campaign_id uuid NOT NULL,
    debtor_id uuid,
    phone_intl text NOT NULL,
    chat_id text NOT NULL,
    payload text NOT NULL,
    status text DEFAULT 'pending'::text NOT NULL,
    attempt_count integer DEFAULT 0 NOT NULL,
    max_attempts integer DEFAULT 5 NOT NULL,
    next_attempt_at timestamp with time zone DEFAULT now() NOT NULL,
    worker_id text,
    processing_started_at timestamp with time zone,
    lease_expires_at timestamp with time zone,
    send_attempted_at timestamp with time zone,
    sent_at timestamp with time zone,
    failed_at timestamp with time zone,
    delivered_at timestamp with time zone,
    read_at timestamp with time zone,
    provider_message_id text,
    last_error text,
    error_class text,
    idempotency_key text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    attachments_sent integer DEFAULT 0 NOT NULL,
    contact_id uuid,
    supplier_id uuid,
    email text,
    subject text,
    CONSTRAINT wa_campaign_recipients_contact_or_supplier_check CHECK (((contact_id IS NOT NULL) OR (supplier_id IS NOT NULL))),
    CONSTRAINT wa_campaign_recipients_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'processing'::text, 'sent'::text, 'failed'::text, 'skipped'::text, 'cancelled'::text])))
);


--
-- Name: COLUMN wa_campaign_recipients.attachments_sent; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.wa_campaign_recipients.attachments_sent IS 'How many campaign attachments (in sort_order) were already sent to this recipient; a retry continues from here.';


--
-- Name: COLUMN wa_campaign_recipients.email; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.wa_campaign_recipients.email IS 'Email broadcast: the address this recipient was sent to (snapshot). NULL for a WhatsApp recipient.';


--
-- Name: COLUMN wa_campaign_recipients.subject; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.wa_campaign_recipients.subject IS 'Email broadcast: this recipient''s subject after placeholder interpolation (snapshot, like payload). NULL for WhatsApp.';


--
-- Name: wa_campaigns; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.wa_campaigns (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    type text DEFAULT 'broadcast'::text NOT NULL,
    status text DEFAULT 'draft'::text NOT NULL,
    name text NOT NULL,
    body text NOT NULL,
    template_name text,
    audience jsonb DEFAULT '{}'::jsonb NOT NULL,
    instance_id uuid,
    created_by uuid,
    total_count integer DEFAULT 0 NOT NULL,
    pending_count integer DEFAULT 0 NOT NULL,
    processing_count integer DEFAULT 0 NOT NULL,
    sent_count integer DEFAULT 0 NOT NULL,
    failed_count integer DEFAULT 0 NOT NULL,
    skipped_count integer DEFAULT 0 NOT NULL,
    cancelled_count integer DEFAULT 0 NOT NULL,
    rate_per_min integer DEFAULT 12 NOT NULL,
    dry_run boolean DEFAULT false NOT NULL,
    client_token text,
    scheduled_at timestamp with time zone,
    started_at timestamp with time zone,
    completed_at timestamp with time zone,
    paused_at timestamp with time zone,
    cancelled_at timestamp with time zone,
    last_error text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    created_by_name text,
    channel text DEFAULT 'whatsapp'::text NOT NULL,
    subject text,
    CONSTRAINT wa_campaigns_channel_check CHECK ((channel = ANY (ARRAY['whatsapp'::text, 'email'::text]))),
    CONSTRAINT wa_campaigns_email_subject_check CHECK (((channel <> 'email'::text) OR (subject IS NOT NULL))),
    CONSTRAINT wa_campaigns_rate_per_min_check CHECK (((rate_per_min >= 1) AND (rate_per_min <= 120))),
    CONSTRAINT wa_campaigns_status_check CHECK ((status = ANY (ARRAY['draft'::text, 'queued'::text, 'running'::text, 'paused'::text, 'completed'::text, 'completed_with_errors'::text, 'cancelled'::text, 'failed'::text]))),
    CONSTRAINT wa_campaigns_type_check CHECK ((type = 'broadcast'::text))
);


--
-- Name: COLUMN wa_campaigns.created_by_name; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.wa_campaigns.created_by_name IS 'Snapshot of the creating user''s name — survives the user''s deletion.';


--
-- Name: COLUMN wa_campaigns.channel; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.wa_campaigns.channel IS 'Delivery channel: whatsapp (Green API) or email (SMTP from app_settings). The worker branches on it (09/10/2026).';


--
-- Name: COLUMN wa_campaigns.subject; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.wa_campaigns.subject IS 'Email subject as entered (placeholders unresolved). Required when channel = email; NULL for WhatsApp.';


--
-- Name: wa_message_attachments; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.wa_message_attachments (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    message_id uuid,
    uploaded_by uuid,
    bucket text NOT NULL,
    object_key text NOT NULL,
    original_name text NOT NULL,
    mime_type text NOT NULL,
    size_bytes bigint NOT NULL,
    sort_order integer DEFAULT 0 NOT NULL,
    green_api_url text,
    green_api_url_expires_at timestamp with time zone,
    green_api_error text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    object_deleted_at timestamp with time zone,
    CONSTRAINT wa_message_attachments_size_bytes_check CHECK ((size_bytes > 0))
);


--
-- Name: TABLE wa_message_attachments; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.wa_message_attachments IS 'Files attached to ONE outbound WhatsApp message (chat_messages). message_id NULL = uploaded but not yet sent. The source of truth for a message files; chat_messages keeps the first file in its legacy columns. green_api_url = Green API uploadFile link (15 days) handed to sendFileByUrl.';


--
-- Name: COLUMN wa_message_attachments.object_key; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.wa_message_attachments.object_key IS 'Storage key in `bucket` (whatsapp-attachments, private) — <uuid>.<ext>, ASCII only. The readable name is original_name.';


--
-- Name: COLUMN wa_message_attachments.sort_order; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.wa_message_attachments.sort_order IS 'Send order within the message: the text (or the caption of a single file) goes first, then the files by this column.';


--
-- Name: COLUMN wa_message_attachments.object_deleted_at; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.wa_message_attachments.object_deleted_at IS 'Set by scripts/storage-cleanup.ts when it removed this row''s object from Storage as `staged_old` (unbound and >24h old). The row survives as the record of the upload; the staged lookups skip it so the file can never be attached to a new message. NULL = the object is still there.';


--
-- Name: wa_send_log; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.wa_send_log (
    id bigint NOT NULL,
    bucket text NOT NULL,
    sent_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: wa_send_log_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.wa_send_log_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: wa_send_log_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.wa_send_log_id_seq OWNED BY public.wa_send_log.id;


--
-- Name: wa_worker_heartbeat; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.wa_worker_heartbeat (
    worker_id text NOT NULL,
    last_beat_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: whatsapp_avatars; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.whatsapp_avatars (
    chat_id text NOT NULL,
    avatar_url text,
    fetched_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: whatsapp_broadcasts; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.whatsapp_broadcasts (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    name text NOT NULL,
    body text NOT NULL,
    audience_filter jsonb DEFAULT '{}'::jsonb NOT NULL,
    total_count integer DEFAULT 0 NOT NULL,
    sent_count integer DEFAULT 0 NOT NULL,
    failed_count integer DEFAULT 0 NOT NULL,
    status text DEFAULT 'pending'::text NOT NULL,
    created_by uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    completed_at timestamp with time zone,
    instance_id uuid,
    CONSTRAINT whatsapp_broadcasts_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'running'::text, 'completed'::text, 'failed'::text])))
);


--
-- Name: whatsapp_instances; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.whatsapp_instances (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid NOT NULL,
    display_name text NOT NULL,
    green_instance_id text NOT NULL,
    green_token_enc jsonb NOT NULL,
    api_url text DEFAULT 'https://api.green-api.com'::text NOT NULL,
    state text DEFAULT 'notAuthorized'::text NOT NULL,
    state_checked_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT whatsapp_instances_state_check CHECK ((state = ANY (ARRAY['notAuthorized'::text, 'authorized'::text, 'blocked'::text, 'starting'::text, 'yellowCard'::text, 'sleepMode'::text])))
);


--
-- Name: COLUMN whatsapp_instances.user_id; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.whatsapp_instances.user_id IS 'Nominal technical owner: webhook routing + legacy instance association ONLY. NOT an authorization boundary — never use it to decide who may view chats, send messages, pull messages, or run campaigns. Access is controlled exclusively by the whatsapp_chat permission; the instance is shared between all authorized users. Tech debt: rename to webhook_owner_user_id.';


--
-- Name: whatsapp_templates; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.whatsapp_templates (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    name text NOT NULL,
    content text NOT NULL,
    is_active boolean DEFAULT true NOT NULL,
    created_by uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    subject text
);


--
-- Name: COLUMN whatsapp_templates.subject; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.whatsapp_templates.subject IS 'Optional email subject — fills the subject field when the template is picked for an email broadcast. Ignored by WhatsApp.';


--
-- Name: bllink_scrape_rows id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.bllink_scrape_rows ALTER COLUMN id SET DEFAULT nextval('public.bllink_scrape_rows_id_seq'::regclass);


--
-- Name: wa_send_log id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.wa_send_log ALTER COLUMN id SET DEFAULT nextval('public.wa_send_log_id_seq'::regclass);


--
-- Name: apartment_owner_phones apartment_owner_phones_apartment_phone_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.apartment_owner_phones
    ADD CONSTRAINT apartment_owner_phones_apartment_phone_key UNIQUE (apartment_number, phone_e164);


--
-- Name: apartment_owner_phones apartment_owner_phones_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.apartment_owner_phones
    ADD CONSTRAINT apartment_owner_phones_pkey PRIMARY KEY (id);


--
-- Name: app_settings app_settings_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.app_settings
    ADD CONSTRAINT app_settings_pkey PRIMARY KEY (key);


--
-- Name: areas areas_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.areas
    ADD CONSTRAINT areas_pkey PRIMARY KEY (id);


--
-- Name: audit_log audit_log_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.audit_log
    ADD CONSTRAINT audit_log_pkey PRIMARY KEY (id);


--
-- Name: auth_rate_limits auth_rate_limits_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.auth_rate_limits
    ADD CONSTRAINT auth_rate_limits_pkey PRIMARY KEY (id);


--
-- Name: bllink_scrape_rows bllink_scrape_rows_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.bllink_scrape_rows
    ADD CONSTRAINT bllink_scrape_rows_pkey PRIMARY KEY (id);


--
-- Name: bllink_scrapes bllink_scrapes_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.bllink_scrapes
    ADD CONSTRAINT bllink_scrapes_pkey PRIMARY KEY (id);


--
-- Name: calendar_event_participants calendar_event_participants_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.calendar_event_participants
    ADD CONSTRAINT calendar_event_participants_pkey PRIMARY KEY (id);


--
-- Name: calendar_events calendar_events_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.calendar_events
    ADD CONSTRAINT calendar_events_pkey PRIMARY KEY (id);


--
-- Name: chat_messages chat_messages_external_message_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.chat_messages
    ADD CONSTRAINT chat_messages_external_message_id_key UNIQUE (external_message_id);


--
-- Name: chat_messages chat_messages_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.chat_messages
    ADD CONSTRAINT chat_messages_pkey PRIMARY KEY (id);


--
-- Name: chip_events chip_events_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.chip_events
    ADD CONSTRAINT chip_events_pkey PRIMARY KEY (id);


--
-- Name: chips chips_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.chips
    ADD CONSTRAINT chips_pkey PRIMARY KEY (id);


--
-- Name: comments comments_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.comments
    ADD CONSTRAINT comments_pkey PRIMARY KEY (id);


--
-- Name: completed_actions completed_actions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.completed_actions
    ADD CONSTRAINT completed_actions_pkey PRIMARY KEY (id);


--
-- Name: contact_field_sources contact_field_sources_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.contact_field_sources
    ADD CONSTRAINT contact_field_sources_pkey PRIMARY KEY (apartment_number, field);


--
-- Name: contact_people contact_people_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.contact_people
    ADD CONSTRAINT contact_people_pkey PRIMARY KEY (id);


--
-- Name: contact_sync_suggestions contact_sync_suggestions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.contact_sync_suggestions
    ADD CONSTRAINT contact_sync_suggestions_pkey PRIMARY KEY (id);


--
-- Name: contacts contacts_apartment_number_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.contacts
    ADD CONSTRAINT contacts_apartment_number_key UNIQUE (apartment_number);


--
-- Name: contacts contacts_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.contacts
    ADD CONSTRAINT contacts_pkey PRIMARY KEY (id);


--
-- Name: debtor_debt_snapshots debtor_debt_snapshots_apartment_number_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.debtor_debt_snapshots
    ADD CONSTRAINT debtor_debt_snapshots_apartment_number_key UNIQUE (apartment_number);


--
-- Name: debtor_debt_snapshots debtor_debt_snapshots_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.debtor_debt_snapshots
    ADD CONSTRAINT debtor_debt_snapshots_pkey PRIMARY KEY (id);


--
-- Name: debtor_events debtor_events_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.debtor_events
    ADD CONSTRAINT debtor_events_pkey PRIMARY KEY (id);


--
-- Name: debtors debtors_apartment_number_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.debtors
    ADD CONSTRAINT debtors_apartment_number_key UNIQUE (apartment_number);


--
-- Name: debtors debtors_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.debtors
    ADD CONSTRAINT debtors_pkey PRIMARY KEY (id);


--
-- Name: debtors_stale_import_text_backup debtors_stale_import_text_backup_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.debtors_stale_import_text_backup
    ADD CONSTRAINT debtors_stale_import_text_backup_pkey PRIMARY KEY (debtor_id);


--
-- Name: document_folders document_folders_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.document_folders
    ADD CONSTRAINT document_folders_pkey PRIMARY KEY (id);


--
-- Name: documents documents_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.documents
    ADD CONSTRAINT documents_pkey PRIMARY KEY (id);


--
-- Name: entity_assignees entity_assignees_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.entity_assignees
    ADD CONSTRAINT entity_assignees_pkey PRIMARY KEY (id);


--
-- Name: fin_categories fin_categories_kind_name_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.fin_categories
    ADD CONSTRAINT fin_categories_kind_name_key UNIQUE (kind, name);


--
-- Name: fin_categories fin_categories_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.fin_categories
    ADD CONSTRAINT fin_categories_pkey PRIMARY KEY (id);


--
-- Name: fin_documents fin_documents_object_key_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.fin_documents
    ADD CONSTRAINT fin_documents_object_key_key UNIQUE (object_key);


--
-- Name: fin_documents fin_documents_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.fin_documents
    ADD CONSTRAINT fin_documents_pkey PRIMARY KEY (id);


--
-- Name: fin_drive_connection fin_drive_connection_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.fin_drive_connection
    ADD CONSTRAINT fin_drive_connection_pkey PRIMARY KEY (id);


--
-- Name: fin_entries fin_entries_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.fin_entries
    ADD CONSTRAINT fin_entries_pkey PRIMARY KEY (id);


--
-- Name: fin_settings fin_settings_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.fin_settings
    ADD CONSTRAINT fin_settings_pkey PRIMARY KEY (id);


--
-- Name: finance_month_status finance_month_status_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.finance_month_status
    ADD CONSTRAINT finance_month_status_pkey PRIMARY KEY (year, month);


--
-- Name: import_runs import_runs_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.import_runs
    ADD CONSTRAINT import_runs_pkey PRIMARY KEY (id);


--
-- Name: internal_conversation_participants internal_conversation_participants_conversation_id_user_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.internal_conversation_participants
    ADD CONSTRAINT internal_conversation_participants_conversation_id_user_id_key UNIQUE (conversation_id, user_id);


--
-- Name: internal_conversation_participants internal_conversation_participants_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.internal_conversation_participants
    ADD CONSTRAINT internal_conversation_participants_pkey PRIMARY KEY (id);


--
-- Name: internal_conversations internal_conversations_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.internal_conversations
    ADD CONSTRAINT internal_conversations_pkey PRIMARY KEY (id);


--
-- Name: internal_messages internal_messages_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.internal_messages
    ADD CONSTRAINT internal_messages_pkey PRIMARY KEY (id);


--
-- Name: issue_comments issue_comments_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.issue_comments
    ADD CONSTRAINT issue_comments_pkey PRIMARY KEY (id);


--
-- Name: issues issues_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.issues
    ADD CONSTRAINT issues_pkey PRIMARY KEY (id);


--
-- Name: issues_sort_order_backup issues_sort_order_backup_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.issues_sort_order_backup
    ADD CONSTRAINT issues_sort_order_backup_pkey PRIMARY KEY (issue_id);


--
-- Name: issues issues_ticket_number_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.issues
    ADD CONSTRAINT issues_ticket_number_key UNIQUE (ticket_number);


--
-- Name: legal_status_history legal_status_history_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.legal_status_history
    ADD CONSTRAINT legal_status_history_pkey PRIMARY KEY (id);


--
-- Name: monthly_collections monthly_collections_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.monthly_collections
    ADD CONSTRAINT monthly_collections_pkey PRIMARY KEY (id);


--
-- Name: monthly_debt_snapshots monthly_debt_snapshots_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.monthly_debt_snapshots
    ADD CONSTRAINT monthly_debt_snapshots_pkey PRIMARY KEY (id);


--
-- Name: notifications notifications_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.notifications
    ADD CONSTRAINT notifications_pkey PRIMARY KEY (id);


--
-- Name: parking_spots parking_spots_lot_spot_uniq; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.parking_spots
    ADD CONSTRAINT parking_spots_lot_spot_uniq UNIQUE (lot_code, spot_number);


--
-- Name: parking_spots parking_spots_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.parking_spots
    ADD CONSTRAINT parking_spots_pkey PRIMARY KEY (id);


--
-- Name: password_reset_tokens password_reset_tokens_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.password_reset_tokens
    ADD CONSTRAINT password_reset_tokens_pkey PRIMARY KEY (token);


--
-- Name: portal_decisions portal_decisions_object_key_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.portal_decisions
    ADD CONSTRAINT portal_decisions_object_key_key UNIQUE (object_key);


--
-- Name: portal_decisions portal_decisions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.portal_decisions
    ADD CONSTRAINT portal_decisions_pkey PRIMARY KEY (id);


--
-- Name: portal_identity_apartments portal_identity_apartments_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.portal_identity_apartments
    ADD CONSTRAINT portal_identity_apartments_pkey PRIMARY KEY (approval_id, apartment_number);


--
-- Name: portal_identity_approvals portal_identity_approvals_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.portal_identity_approvals
    ADD CONSTRAINT portal_identity_approvals_pkey PRIMARY KEY (id);


--
-- Name: portal_lockouts portal_lockouts_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.portal_lockouts
    ADD CONSTRAINT portal_lockouts_pkey PRIMARY KEY (id);


--
-- Name: portal_login_events portal_login_events_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.portal_login_events
    ADD CONSTRAINT portal_login_events_pkey PRIMARY KEY (id);


--
-- Name: portal_otp_codes portal_otp_codes_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.portal_otp_codes
    ADD CONSTRAINT portal_otp_codes_pkey PRIMARY KEY (id);


--
-- Name: portal_phone_entry_flags portal_phone_entry_flags_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.portal_phone_entry_flags
    ADD CONSTRAINT portal_phone_entry_flags_pkey PRIMARY KEY (id);


--
-- Name: portal_sessions portal_sessions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.portal_sessions
    ADD CONSTRAINT portal_sessions_pkey PRIMARY KEY (id);


--
-- Name: portal_sessions portal_sessions_token_hash_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.portal_sessions
    ADD CONSTRAINT portal_sessions_token_hash_key UNIQUE (token_hash);


--
-- Name: reminder_categories reminder_categories_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.reminder_categories
    ADD CONSTRAINT reminder_categories_pkey PRIMARY KEY (id);


--
-- Name: reminders reminders_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.reminders
    ADD CONSTRAINT reminders_pkey PRIMARY KEY (id);


--
-- Name: renovation_fund_settings renovation_fund_settings_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.renovation_fund_settings
    ADD CONSTRAINT renovation_fund_settings_pkey PRIMARY KEY (id);


--
-- Name: schema_migrations schema_migrations_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.schema_migrations
    ADD CONSTRAINT schema_migrations_pkey PRIMARY KEY (version);


--
-- Name: sessions sessions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sessions
    ADD CONSTRAINT sessions_pkey PRIMARY KEY (id);


--
-- Name: statuses statuses_name_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.statuses
    ADD CONSTRAINT statuses_name_key UNIQUE (name);


--
-- Name: statuses statuses_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.statuses
    ADD CONSTRAINT statuses_pkey PRIMARY KEY (id);


--
-- Name: storage_cleanup_runs storage_cleanup_runs_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.storage_cleanup_runs
    ADD CONSTRAINT storage_cleanup_runs_pkey PRIMARY KEY (id);


--
-- Name: storage_units storage_units_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.storage_units
    ADD CONSTRAINT storage_units_pkey PRIMARY KEY (id);


--
-- Name: supplier_categories supplier_categories_name_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.supplier_categories
    ADD CONSTRAINT supplier_categories_name_key UNIQUE (name);


--
-- Name: supplier_categories supplier_categories_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.supplier_categories
    ADD CONSTRAINT supplier_categories_pkey PRIMARY KEY (id);


--
-- Name: supplier_contacts supplier_contacts_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.supplier_contacts
    ADD CONSTRAINT supplier_contacts_pkey PRIMARY KEY (id);


--
-- Name: supplier_documents supplier_documents_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.supplier_documents
    ADD CONSTRAINT supplier_documents_pkey PRIMARY KEY (id);


--
-- Name: suppliers suppliers_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.suppliers
    ADD CONSTRAINT suppliers_pkey PRIMARY KEY (id);


--
-- Name: sync_runs sync_runs_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sync_runs
    ADD CONSTRAINT sync_runs_pkey PRIMARY KEY (id);


--
-- Name: task_comments task_comments_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.task_comments
    ADD CONSTRAINT task_comments_pkey PRIMARY KEY (id);


--
-- Name: task_occurrence_completions task_occurrence_completions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.task_occurrence_completions
    ADD CONSTRAINT task_occurrence_completions_pkey PRIMARY KEY (id);


--
-- Name: task_occurrence_completions task_occurrence_completions_task_id_occurrence_date_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.task_occurrence_completions
    ADD CONSTRAINT task_occurrence_completions_task_id_occurrence_date_key UNIQUE (task_id, occurrence_date);


--
-- Name: task_recurrence_exceptions task_recurrence_exceptions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.task_recurrence_exceptions
    ADD CONSTRAINT task_recurrence_exceptions_pkey PRIMARY KEY (id);


--
-- Name: task_recurrence_exceptions task_recurrence_exceptions_recurrence_id_excluded_date_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.task_recurrence_exceptions
    ADD CONSTRAINT task_recurrence_exceptions_recurrence_id_excluded_date_key UNIQUE (recurrence_id, excluded_date);


--
-- Name: task_recurrences task_recurrences_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.task_recurrences
    ADD CONSTRAINT task_recurrences_pkey PRIMARY KEY (id);


--
-- Name: tasks tasks_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tasks
    ADD CONSTRAINT tasks_pkey PRIMARY KEY (id);


--
-- Name: user_invites user_invites_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_invites
    ADD CONSTRAINT user_invites_pkey PRIMARY KEY (id);


--
-- Name: user_invites user_invites_token_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_invites
    ADD CONSTRAINT user_invites_token_key UNIQUE (token);


--
-- Name: user_permissions user_permissions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_permissions
    ADD CONSTRAINT user_permissions_pkey PRIMARY KEY (id);


--
-- Name: user_permissions user_permissions_user_id_module_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_permissions
    ADD CONSTRAINT user_permissions_user_id_module_key UNIQUE (user_id, module);


--
-- Name: user_reminder_attachments user_reminder_attachments_object_key_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_reminder_attachments
    ADD CONSTRAINT user_reminder_attachments_object_key_key UNIQUE (object_key);


--
-- Name: user_reminder_attachments user_reminder_attachments_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_reminder_attachments
    ADD CONSTRAINT user_reminder_attachments_pkey PRIMARY KEY (id);


--
-- Name: user_reminder_order user_reminder_order_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_reminder_order
    ADD CONSTRAINT user_reminder_order_pkey PRIMARY KEY (user_id, reminder_id);


--
-- Name: user_reminders user_reminders_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_reminders
    ADD CONSTRAINT user_reminders_pkey PRIMARY KEY (id);


--
-- Name: users users_email_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.users
    ADD CONSTRAINT users_email_key UNIQUE (email);


--
-- Name: users users_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.users
    ADD CONSTRAINT users_pkey PRIMARY KEY (id);


--
-- Name: users users_username_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.users
    ADD CONSTRAINT users_username_key UNIQUE (username);


--
-- Name: wa_campaign_attachments wa_campaign_attachments_object_key_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.wa_campaign_attachments
    ADD CONSTRAINT wa_campaign_attachments_object_key_key UNIQUE (object_key);


--
-- Name: wa_campaign_attachments wa_campaign_attachments_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.wa_campaign_attachments
    ADD CONSTRAINT wa_campaign_attachments_pkey PRIMARY KEY (id);


--
-- Name: wa_campaign_recipient_apartments wa_campaign_recipient_apartments_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.wa_campaign_recipient_apartments
    ADD CONSTRAINT wa_campaign_recipient_apartments_pkey PRIMARY KEY (id);


--
-- Name: wa_campaign_recipient_apartments wa_campaign_recipient_apartments_recipient_id_contact_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.wa_campaign_recipient_apartments
    ADD CONSTRAINT wa_campaign_recipient_apartments_recipient_id_contact_id_key UNIQUE (recipient_id, contact_id);


--
-- Name: wa_campaign_recipients wa_campaign_recipients_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.wa_campaign_recipients
    ADD CONSTRAINT wa_campaign_recipients_pkey PRIMARY KEY (id);


--
-- Name: wa_campaigns wa_campaigns_client_token_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.wa_campaigns
    ADD CONSTRAINT wa_campaigns_client_token_key UNIQUE (client_token);


--
-- Name: wa_campaigns wa_campaigns_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.wa_campaigns
    ADD CONSTRAINT wa_campaigns_pkey PRIMARY KEY (id);


--
-- Name: wa_message_attachments wa_message_attachments_object_key_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.wa_message_attachments
    ADD CONSTRAINT wa_message_attachments_object_key_key UNIQUE (object_key);


--
-- Name: wa_message_attachments wa_message_attachments_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.wa_message_attachments
    ADD CONSTRAINT wa_message_attachments_pkey PRIMARY KEY (id);


--
-- Name: wa_send_log wa_send_log_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.wa_send_log
    ADD CONSTRAINT wa_send_log_pkey PRIMARY KEY (id);


--
-- Name: wa_worker_heartbeat wa_worker_heartbeat_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.wa_worker_heartbeat
    ADD CONSTRAINT wa_worker_heartbeat_pkey PRIMARY KEY (worker_id);


--
-- Name: whatsapp_avatars whatsapp_avatars_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.whatsapp_avatars
    ADD CONSTRAINT whatsapp_avatars_pkey PRIMARY KEY (chat_id);


--
-- Name: whatsapp_broadcasts whatsapp_broadcasts_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.whatsapp_broadcasts
    ADD CONSTRAINT whatsapp_broadcasts_pkey PRIMARY KEY (id);


--
-- Name: whatsapp_instances whatsapp_instances_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.whatsapp_instances
    ADD CONSTRAINT whatsapp_instances_pkey PRIMARY KEY (id);


--
-- Name: whatsapp_instances whatsapp_instances_user_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.whatsapp_instances
    ADD CONSTRAINT whatsapp_instances_user_id_key UNIQUE (user_id);


--
-- Name: whatsapp_templates whatsapp_templates_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.whatsapp_templates
    ADD CONSTRAINT whatsapp_templates_pkey PRIMARY KEY (id);


--
-- Name: apartment_owner_phones_phone_e164_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX apartment_owner_phones_phone_e164_idx ON public.apartment_owner_phones USING btree (phone_e164);


--
-- Name: audit_log_actor_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX audit_log_actor_idx ON public.audit_log USING btree (actor_user_id);


--
-- Name: audit_log_created_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX audit_log_created_idx ON public.audit_log USING btree (created_at DESC);


--
-- Name: audit_log_entity_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX audit_log_entity_idx ON public.audit_log USING btree (entity_type, entity_id);


--
-- Name: auth_rate_limits_bucket_time_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX auth_rate_limits_bucket_time_idx ON public.auth_rate_limits USING btree (bucket, hit_at);


--
-- Name: bllink_scrape_rows_scrape_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX bllink_scrape_rows_scrape_id_idx ON public.bllink_scrape_rows USING btree (scrape_id);


--
-- Name: bllink_scrapes_started_at_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX bllink_scrapes_started_at_idx ON public.bllink_scrapes USING btree (started_at DESC);


--
-- Name: calendar_event_participants_event_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX calendar_event_participants_event_idx ON public.calendar_event_participants USING btree (event_id);


--
-- Name: calendar_event_participants_uniq; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX calendar_event_participants_uniq ON public.calendar_event_participants USING btree (event_id, participant_source, participant_id);


--
-- Name: calendar_events_event_date_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX calendar_events_event_date_idx ON public.calendar_events USING btree (event_date);


--
-- Name: calendar_events_owner_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX calendar_events_owner_idx ON public.calendar_events USING btree (owner_user_id);


--
-- Name: calendar_events_parent_series_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX calendar_events_parent_series_idx ON public.calendar_events USING btree (parent_series_id);


--
-- Name: chat_messages_broadcast_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX chat_messages_broadcast_idx ON public.chat_messages USING btree (broadcast_id);


--
-- Name: chat_messages_chat_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX chat_messages_chat_id_idx ON public.chat_messages USING btree (chat_id);


--
-- Name: chat_messages_debtor_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX chat_messages_debtor_idx ON public.chat_messages USING btree (debtor_id, created_at DESC);


--
-- Name: chat_messages_external_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX chat_messages_external_id_idx ON public.chat_messages USING btree (external_message_id);


--
-- Name: chat_messages_instance_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX chat_messages_instance_idx ON public.chat_messages USING btree (instance_id, chat_id);


--
-- Name: chip_events_chip_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX chip_events_chip_idx ON public.chip_events USING btree (chip_id, created_at DESC);


--
-- Name: chips_apartment_trgm_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX chips_apartment_trgm_idx ON public.chips USING gin (apartment_number public.gin_trgm_ops);


--
-- Name: chips_contact_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX chips_contact_idx ON public.chips USING btree (contact_id);


--
-- Name: chips_holder_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX chips_holder_idx ON public.chips USING btree (contact_id, resident_role, status);


--
-- Name: chips_holder_name_trgm_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX chips_holder_name_trgm_idx ON public.chips USING gin (holder_name public.gin_trgm_ops);


--
-- Name: chips_number_active_uniq; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX chips_number_active_uniq ON public.chips USING btree (chip_number) WHERE (status = 'active'::text);


--
-- Name: chips_number_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX chips_number_idx ON public.chips USING btree (chip_number);


--
-- Name: chips_number_trgm_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX chips_number_trgm_idx ON public.chips USING gin (chip_number public.gin_trgm_ops);


--
-- Name: chips_pending_sync; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX chips_pending_sync ON public.chips USING btree (id) WHERE ((status = 'inactive'::text) AND (controller_synced = false));


--
-- Name: chips_status_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX chips_status_idx ON public.chips USING btree (status);


--
-- Name: chips_type_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX chips_type_idx ON public.chips USING btree (chip_type);


--
-- Name: comments_created_at_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX comments_created_at_idx ON public.comments USING btree (created_at DESC);


--
-- Name: comments_debtor_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX comments_debtor_idx ON public.comments USING btree (debtor_id);


--
-- Name: completed_actions_completed_at_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX completed_actions_completed_at_idx ON public.completed_actions USING btree (completed_at DESC);


--
-- Name: completed_actions_debtor_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX completed_actions_debtor_idx ON public.completed_actions USING btree (debtor_id);


--
-- Name: contact_people_contact_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX contact_people_contact_id_idx ON public.contact_people USING btree (contact_id, role, sort_order);


--
-- Name: contact_people_recipients_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX contact_people_recipients_idx ON public.contact_people USING btree (contact_id) WHERE (is_primary_contact AND (phone IS NOT NULL));


--
-- Name: contact_sync_suggestions_one_open; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX contact_sync_suggestions_one_open ON public.contact_sync_suggestions USING btree (apartment_number, field) WHERE ((status = 'pending'::text) AND (phone_e164 IS NULL));


--
-- Name: contact_sync_suggestions_one_open_person; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX contact_sync_suggestions_one_open_person ON public.contact_sync_suggestions USING btree (apartment_number, field, phone_e164) WHERE ((status = 'pending'::text) AND (phone_e164 IS NOT NULL));


--
-- Name: contact_sync_suggestions_pending_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX contact_sync_suggestions_pending_idx ON public.contact_sync_suggestions USING btree (created_at DESC) WHERE (status = 'pending'::text);


--
-- Name: contact_sync_suggestions_rejected_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX contact_sync_suggestions_rejected_idx ON public.contact_sync_suggestions USING btree (apartment_number, field) WHERE (status = 'rejected'::text);


--
-- Name: contacts_operator_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX contacts_operator_id_idx ON public.contacts USING btree (operator_id);


--
-- Name: contacts_operator_name_trgm_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX contacts_operator_name_trgm_idx ON public.contacts USING gin (operator_name public.gin_trgm_ops);


--
-- Name: contacts_owner_name_trgm_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX contacts_owner_name_trgm_idx ON public.contacts USING gin (owner_name public.gin_trgm_ops);


--
-- Name: contacts_tags_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX contacts_tags_idx ON public.contacts USING gin (tags);


--
-- Name: contacts_tenant_name_trgm_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX contacts_tenant_name_trgm_idx ON public.contacts USING gin (tenant_name public.gin_trgm_ops);


--
-- Name: debtor_events_debtor_created_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX debtor_events_debtor_created_idx ON public.debtor_events USING btree (debtor_id, created_at DESC);


--
-- Name: debtor_events_type_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX debtor_events_type_idx ON public.debtor_events USING btree (event_type);


--
-- Name: debtors_apt_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX debtors_apt_idx ON public.debtors USING btree (apartment_number);


--
-- Name: debtors_contact_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX debtors_contact_id_idx ON public.debtors USING btree (contact_id);


--
-- Name: debtors_is_archived_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX debtors_is_archived_idx ON public.debtors USING btree (is_archived);


--
-- Name: debtors_legal_status_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX debtors_legal_status_id_idx ON public.debtors USING btree (legal_status_id);


--
-- Name: document_folders_created_by_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX document_folders_created_by_idx ON public.document_folders USING btree (created_by);


--
-- Name: document_folders_parent_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX document_folders_parent_idx ON public.document_folders USING btree (parent_folder_id);


--
-- Name: documents_entity_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX documents_entity_idx ON public.documents USING btree (entity_type, entity_id);


--
-- Name: documents_folder_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX documents_folder_idx ON public.documents USING btree (folder_id);


--
-- Name: documents_uploaded_by_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX documents_uploaded_by_idx ON public.documents USING btree (uploaded_by);


--
-- Name: entity_assignees_entity_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX entity_assignees_entity_idx ON public.entity_assignees USING btree (entity_type, entity_id);


--
-- Name: entity_assignees_supplier_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX entity_assignees_supplier_idx ON public.entity_assignees USING btree (supplier_id) WHERE (supplier_id IS NOT NULL);


--
-- Name: entity_assignees_uniq; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX entity_assignees_uniq ON public.entity_assignees USING btree (entity_type, entity_id, assignee_type, COALESCE(user_id, supplier_id));


--
-- Name: entity_assignees_user_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX entity_assignees_user_idx ON public.entity_assignees USING btree (user_id) WHERE (user_id IS NOT NULL);


--
-- Name: fin_categories_kind_sort_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX fin_categories_kind_sort_idx ON public.fin_categories USING btree (kind, sort_order, name);


--
-- Name: fin_documents_drive_pending_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX fin_documents_drive_pending_idx ON public.fin_documents USING btree (drive_status, created_at) WHERE (drive_status <> 'done'::text);


--
-- Name: fin_documents_entry_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX fin_documents_entry_idx ON public.fin_documents USING btree (entry_id, created_at);


--
-- Name: fin_documents_staged_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX fin_documents_staged_idx ON public.fin_documents USING btree (uploaded_by, created_at) WHERE (entry_id IS NULL);


--
-- Name: fin_entries_category_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX fin_entries_category_idx ON public.fin_entries USING btree (category_id);


--
-- Name: fin_entries_invoice_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX fin_entries_invoice_idx ON public.fin_entries USING btree (lower(invoice_number), supplier_id) WHERE (deleted_at IS NULL);


--
-- Name: fin_entries_period_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX fin_entries_period_idx ON public.fin_entries USING btree (period_month) WHERE (deleted_at IS NULL);


--
-- Name: idx_chat_messages_supplier; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_chat_messages_supplier ON public.chat_messages USING btree (supplier_id);


--
-- Name: idx_import_runs_kind; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_import_runs_kind ON public.import_runs USING btree (kind);


--
-- Name: idx_issues_supplier; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_issues_supplier ON public.issues USING btree (supplier_id);


--
-- Name: idx_issues_target; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_issues_target ON public.issues USING btree (target_type, target_id) WHERE (target_id IS NOT NULL);


--
-- Name: idx_supplier_docs_supplier; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_supplier_docs_supplier ON public.supplier_documents USING btree (supplier_id);


--
-- Name: idx_suppliers_category; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_suppliers_category ON public.suppliers USING btree (category_id) WHERE (deleted_at IS NULL);


--
-- Name: idx_suppliers_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_suppliers_status ON public.suppliers USING btree (status) WHERE (deleted_at IS NULL);


--
-- Name: idx_suppliers_type; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_suppliers_type ON public.suppliers USING btree (supplier_type) WHERE (deleted_at IS NULL);


--
-- Name: idx_tasks_supplier; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_tasks_supplier ON public.tasks USING btree (supplier_id);


--
-- Name: idx_tasks_target; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_tasks_target ON public.tasks USING btree (target_type, target_id) WHERE (target_id IS NOT NULL);


--
-- Name: idx_user_invites_email_lower; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_user_invites_email_lower ON public.user_invites USING btree (lower(email));


--
-- Name: idx_user_invites_token; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_user_invites_token ON public.user_invites USING btree (token);


--
-- Name: idx_user_permissions_user; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_user_permissions_user ON public.user_permissions USING btree (user_id);


--
-- Name: import_runs_started_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX import_runs_started_idx ON public.import_runs USING btree (started_at DESC);


--
-- Name: import_runs_status_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX import_runs_status_idx ON public.import_runs USING btree (status);


--
-- Name: internal_conversations_type_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX internal_conversations_type_idx ON public.internal_conversations USING btree (type);


--
-- Name: internal_conversations_updated_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX internal_conversations_updated_idx ON public.internal_conversations USING btree (updated_at DESC);


--
-- Name: internal_messages_conversation_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX internal_messages_conversation_idx ON public.internal_messages USING btree (conversation_id, created_at);


--
-- Name: internal_participants_conversation_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX internal_participants_conversation_idx ON public.internal_conversation_participants USING btree (conversation_id);


--
-- Name: internal_participants_user_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX internal_participants_user_idx ON public.internal_conversation_participants USING btree (user_id);


--
-- Name: issue_comments_issue_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX issue_comments_issue_id_idx ON public.issue_comments USING btree (issue_id, created_at);


--
-- Name: issues_assigned_to_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX issues_assigned_to_idx ON public.issues USING btree (assigned_to_user_id);


--
-- Name: issues_due_date_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX issues_due_date_idx ON public.issues USING btree (due_date) WHERE (due_date IS NOT NULL);


--
-- Name: issues_priority_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX issues_priority_idx ON public.issues USING btree (priority);


--
-- Name: issues_status_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX issues_status_idx ON public.issues USING btree (status);


--
-- Name: issues_status_sort_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX issues_status_sort_idx ON public.issues USING btree (status, sort_order);


--
-- Name: legal_status_history_changed_at_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX legal_status_history_changed_at_idx ON public.legal_status_history USING btree (changed_at DESC);


--
-- Name: legal_status_history_debtor_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX legal_status_history_debtor_idx ON public.legal_status_history USING btree (debtor_id);


--
-- Name: monthly_collections_ym_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX monthly_collections_ym_idx ON public.monthly_collections USING btree (year, month);


--
-- Name: monthly_debt_snapshots_ym_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX monthly_debt_snapshots_ym_idx ON public.monthly_debt_snapshots USING btree (snapshot_year, snapshot_month);


--
-- Name: notifications_dedupe_key_uidx; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX notifications_dedupe_key_uidx ON public.notifications USING btree (dedupe_key) WHERE (dedupe_key IS NOT NULL);


--
-- Name: notifications_user_active_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX notifications_user_active_idx ON public.notifications USING btree (user_id, is_read, created_at DESC) WHERE (cleared_at IS NULL);


--
-- Name: notifications_user_created_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX notifications_user_created_idx ON public.notifications USING btree (user_id, created_at DESC);


--
-- Name: notifications_user_read_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX notifications_user_read_idx ON public.notifications USING btree (user_id, is_read);


--
-- Name: notifications_user_unread_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX notifications_user_unread_idx ON public.notifications USING btree (user_id, is_read, created_at DESC);


--
-- Name: parking_spots_apartment_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX parking_spots_apartment_idx ON public.parking_spots USING btree (apartment_number) WHERE (apartment_number IS NOT NULL);


--
-- Name: parking_spots_owner_type_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX parking_spots_owner_type_idx ON public.parking_spots USING btree (owner_type);


--
-- Name: password_reset_tokens_user_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX password_reset_tokens_user_idx ON public.password_reset_tokens USING btree (user_id);


--
-- Name: portal_decisions_published_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX portal_decisions_published_idx ON public.portal_decisions USING btree (published, decided_at DESC);


--
-- Name: portal_identity_approvals_one_approved; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX portal_identity_approvals_one_approved ON public.portal_identity_approvals USING btree (phone_e164) WHERE (status = 'approved'::text);


--
-- Name: portal_identity_approvals_one_pending; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX portal_identity_approvals_one_pending ON public.portal_identity_approvals USING btree (phone_e164) WHERE (status = 'pending'::text);


--
-- Name: portal_lockouts_phone_created_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX portal_lockouts_phone_created_idx ON public.portal_lockouts USING btree (phone_e164, created_at DESC);


--
-- Name: portal_login_events_created_at_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX portal_login_events_created_at_idx ON public.portal_login_events USING btree (created_at DESC);


--
-- Name: portal_login_events_phone_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX portal_login_events_phone_idx ON public.portal_login_events USING btree (phone_e164);


--
-- Name: portal_otp_codes_phone_created_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX portal_otp_codes_phone_created_idx ON public.portal_otp_codes USING btree (phone_e164, created_at DESC);


--
-- Name: portal_phone_entry_flags_open; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX portal_phone_entry_flags_open ON public.portal_phone_entry_flags USING btree (phone_e164) WHERE (cleared_at IS NULL);


--
-- Name: portal_sessions_phone_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX portal_sessions_phone_idx ON public.portal_sessions USING btree (phone_e164);


--
-- Name: reminder_categories_created_by_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX reminder_categories_created_by_idx ON public.reminder_categories USING btree (created_by);


--
-- Name: reminder_categories_order_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX reminder_categories_order_idx ON public.reminder_categories USING btree (display_order, name);


--
-- Name: reminders_due_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX reminders_due_idx ON public.reminders USING btree (remind_at) WHERE (sent_at IS NULL);


--
-- Name: reminders_entity_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX reminders_entity_idx ON public.reminders USING btree (entity_type, entity_id);


--
-- Name: sessions_expires_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX sessions_expires_idx ON public.sessions USING btree (expires_at);


--
-- Name: sessions_user_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX sessions_user_idx ON public.sessions USING btree (user_id);


--
-- Name: statuses_active_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX statuses_active_idx ON public.statuses USING btree (is_active);


--
-- Name: statuses_one_default_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX statuses_one_default_idx ON public.statuses USING btree (is_default) WHERE (is_default = true);


--
-- Name: statuses_sort_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX statuses_sort_idx ON public.statuses USING btree (sort_order);


--
-- Name: storage_cleanup_runs_started_at_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX storage_cleanup_runs_started_at_idx ON public.storage_cleanup_runs USING btree (started_at DESC);


--
-- Name: storage_units_apartment_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX storage_units_apartment_idx ON public.storage_units USING btree (apartment_number) WHERE (apartment_number IS NOT NULL);


--
-- Name: storage_units_number_active_uniq; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX storage_units_number_active_uniq ON public.storage_units USING btree (unit_number) WHERE is_active;


--
-- Name: storage_units_owner_type_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX storage_units_owner_type_idx ON public.storage_units USING btree (owner_type);


--
-- Name: supplier_contacts_supplier_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX supplier_contacts_supplier_id_idx ON public.supplier_contacts USING btree (supplier_id, sort_order);


--
-- Name: sync_runs_started_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX sync_runs_started_idx ON public.sync_runs USING btree (started_at DESC);


--
-- Name: task_comments_task_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX task_comments_task_id_idx ON public.task_comments USING btree (task_id, created_at);


--
-- Name: task_occurrence_completions_recurrence_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX task_occurrence_completions_recurrence_idx ON public.task_occurrence_completions USING btree (recurrence_id);


--
-- Name: task_occurrence_completions_task_date_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX task_occurrence_completions_task_date_idx ON public.task_occurrence_completions USING btree (task_id, occurrence_date DESC);


--
-- Name: task_recurrence_exceptions_recurrence_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX task_recurrence_exceptions_recurrence_id_idx ON public.task_recurrence_exceptions USING btree (recurrence_id);


--
-- Name: task_recurrences_task_uniq; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX task_recurrences_task_uniq ON public.task_recurrences USING btree (task_id);


--
-- Name: tasks_assigned_to_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX tasks_assigned_to_idx ON public.tasks USING btree (assigned_to_user_id);


--
-- Name: tasks_due_date_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX tasks_due_date_idx ON public.tasks USING btree (due_date);


--
-- Name: tasks_is_recurring_template_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX tasks_is_recurring_template_idx ON public.tasks USING btree (is_recurring_template) WHERE is_recurring_template;


--
-- Name: tasks_issue_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX tasks_issue_id_idx ON public.tasks USING btree (issue_id);


--
-- Name: tasks_recurrence_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX tasks_recurrence_id_idx ON public.tasks USING btree (recurrence_id);


--
-- Name: tasks_recurrence_single_row_uniq; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX tasks_recurrence_single_row_uniq ON public.tasks USING btree (recurrence_id) WHERE (recurrence_id IS NOT NULL);


--
-- Name: tasks_related_entity_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX tasks_related_entity_idx ON public.tasks USING btree (related_entity_type, related_entity_id);


--
-- Name: tasks_status_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX tasks_status_idx ON public.tasks USING btree (status);


--
-- Name: tasks_status_sort_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX tasks_status_sort_idx ON public.tasks USING btree (status, sort_order);


--
-- Name: user_reminder_attachments_reminder_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX user_reminder_attachments_reminder_idx ON public.user_reminder_attachments USING btree (reminder_id, created_at);


--
-- Name: user_reminder_attachments_staged_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX user_reminder_attachments_staged_idx ON public.user_reminder_attachments USING btree (uploaded_by, created_at) WHERE (reminder_id IS NULL);


--
-- Name: user_reminder_order_user_position_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX user_reminder_order_user_position_idx ON public.user_reminder_order USING btree (user_id, "position");


--
-- Name: user_reminders_assigned_to_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX user_reminders_assigned_to_idx ON public.user_reminders USING btree (assigned_to);


--
-- Name: user_reminders_category_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX user_reminders_category_idx ON public.user_reminders USING btree (category_id);


--
-- Name: user_reminders_entity_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX user_reminders_entity_idx ON public.user_reminders USING btree (entity_type, entity_id);


--
-- Name: user_reminders_remind_at_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX user_reminders_remind_at_idx ON public.user_reminders USING btree (remind_at);


--
-- Name: user_reminders_status_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX user_reminders_status_idx ON public.user_reminders USING btree (status);


--
-- Name: users_email_lower_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX users_email_lower_idx ON public.users USING btree (lower(email));


--
-- Name: users_username_lower_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX users_username_lower_idx ON public.users USING btree (lower(username));


--
-- Name: wa_campaign_attachments_campaign_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX wa_campaign_attachments_campaign_idx ON public.wa_campaign_attachments USING btree (campaign_id, sort_order);


--
-- Name: wa_campaign_attachments_staged_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX wa_campaign_attachments_staged_idx ON public.wa_campaign_attachments USING btree (uploaded_by, created_at) WHERE (campaign_id IS NULL);


--
-- Name: wa_campaign_recipient_apartments_contact_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX wa_campaign_recipient_apartments_contact_id_idx ON public.wa_campaign_recipient_apartments USING btree (contact_id);


--
-- Name: wa_campaign_recipient_apartments_recipient_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX wa_campaign_recipient_apartments_recipient_id_idx ON public.wa_campaign_recipient_apartments USING btree (recipient_id);


--
-- Name: wa_campaign_recipients_contact_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX wa_campaign_recipients_contact_id_idx ON public.wa_campaign_recipients USING btree (contact_id);


--
-- Name: wa_campaigns_status_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX wa_campaigns_status_idx ON public.wa_campaigns USING btree (status, created_at DESC);


--
-- Name: wa_message_attachments_message_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX wa_message_attachments_message_idx ON public.wa_message_attachments USING btree (message_id, sort_order);


--
-- Name: wa_message_attachments_staged_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX wa_message_attachments_staged_idx ON public.wa_message_attachments USING btree (uploaded_by, created_at) WHERE (message_id IS NULL);


--
-- Name: wa_recipients_claimable_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX wa_recipients_claimable_idx ON public.wa_campaign_recipients USING btree (campaign_id, status, next_attempt_at);


--
-- Name: wa_recipients_idem_uidx; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX wa_recipients_idem_uidx ON public.wa_campaign_recipients USING btree (idempotency_key);


--
-- Name: wa_recipients_lease_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX wa_recipients_lease_idx ON public.wa_campaign_recipients USING btree (status, lease_expires_at);


--
-- Name: wa_recipients_provider_msg_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX wa_recipients_provider_msg_idx ON public.wa_campaign_recipients USING btree (provider_message_id);


--
-- Name: wa_send_log_bucket_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX wa_send_log_bucket_idx ON public.wa_send_log USING btree (bucket, sent_at DESC);


--
-- Name: whatsapp_broadcasts_created_at_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX whatsapp_broadcasts_created_at_idx ON public.whatsapp_broadcasts USING btree (created_at DESC);


--
-- Name: whatsapp_instances_green_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX whatsapp_instances_green_id_idx ON public.whatsapp_instances USING btree (green_instance_id);


--
-- Name: whatsapp_templates_active_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX whatsapp_templates_active_idx ON public.whatsapp_templates USING btree (is_active);


--
-- Name: areas areas_touch_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER areas_touch_updated_at BEFORE UPDATE ON public.areas FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();


--
-- Name: calendar_event_participants calendar_event_participants_touch_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER calendar_event_participants_touch_updated_at BEFORE UPDATE ON public.calendar_event_participants FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();


--
-- Name: calendar_events calendar_events_touch_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER calendar_events_touch_updated_at BEFORE UPDATE ON public.calendar_events FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();


--
-- Name: chips chips_touch_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER chips_touch_updated_at BEFORE UPDATE ON public.chips FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();


--
-- Name: contact_people contact_people_touch_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER contact_people_touch_updated_at BEFORE UPDATE ON public.contact_people FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();


--
-- Name: contacts contacts_block_delete_with_active_debt; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER contacts_block_delete_with_active_debt BEFORE DELETE ON public.contacts FOR EACH ROW EXECUTE FUNCTION public.block_delete_contact_with_active_debt();


--
-- Name: contacts contacts_field_provenance_aiu; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER contacts_field_provenance_aiu AFTER INSERT OR UPDATE OF owner_name, owner_phone, owner_email, tenant_name, tenant_phone, tenant_email ON public.contacts FOR EACH ROW EXECUTE FUNCTION public.contacts_field_provenance();


--
-- Name: contacts contacts_touch_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER contacts_touch_updated_at BEFORE UPDATE ON public.contacts FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();


--
-- Name: debtors debtors_touch_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER debtors_touch_updated_at BEFORE UPDATE ON public.debtors FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();


--
-- Name: document_folders document_folders_touch_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER document_folders_touch_updated_at BEFORE UPDATE ON public.document_folders FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();


--
-- Name: documents documents_touch_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER documents_touch_updated_at BEFORE UPDATE ON public.documents FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();


--
-- Name: fin_entries fin_entries_touch_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER fin_entries_touch_updated_at BEFORE UPDATE ON public.fin_entries FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();


--
-- Name: issue_comments issue_comments_touch_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER issue_comments_touch_updated_at BEFORE UPDATE ON public.issue_comments FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();


--
-- Name: issues issues_touch_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER issues_touch_updated_at BEFORE UPDATE ON public.issues FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();


--
-- Name: notifications notifications_touch_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER notifications_touch_updated_at BEFORE UPDATE ON public.notifications FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();


--
-- Name: parking_spots parking_spots_touch_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER parking_spots_touch_updated_at BEFORE UPDATE ON public.parking_spots FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();


--
-- Name: contacts portal_roster_from_contact_aiu; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER portal_roster_from_contact_aiu AFTER INSERT OR UPDATE OF owner_phone, owner_name, apartment_number ON public.contacts FOR EACH ROW EXECUTE FUNCTION public.portal_roster_from_contact();

ALTER TABLE public.contacts DISABLE TRIGGER portal_roster_from_contact_aiu;


--
-- Name: contact_people portal_roster_from_contact_person_aiu; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER portal_roster_from_contact_person_aiu AFTER INSERT OR UPDATE OF phone, name, role, contact_id ON public.contact_people FOR EACH ROW EXECUTE FUNCTION public.portal_roster_from_contact_person();

ALTER TABLE public.contact_people DISABLE TRIGGER portal_roster_from_contact_person_aiu;


--
-- Name: contacts portal_roster_sync_contact_aiu; Type: TRIGGER; Schema: public; Owner: -
--

CREATE CONSTRAINT TRIGGER portal_roster_sync_contact_aiu AFTER INSERT OR UPDATE OF owner_phone, owner_name, tenant_phone, tenant_name, operator_phone, operator_name, resident_type, apartment_number ON public.contacts DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.portal_roster_sync_from_contact();


--
-- Name: contact_people portal_roster_sync_contact_person_aiud; Type: TRIGGER; Schema: public; Owner: -
--

CREATE CONSTRAINT TRIGGER portal_roster_sync_contact_person_aiud AFTER INSERT OR DELETE OR UPDATE OF phone, name, role, contact_id ON public.contact_people DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.portal_roster_sync_from_contact_person();


--
-- Name: reminder_categories reminder_categories_touch_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER reminder_categories_touch_updated_at BEFORE UPDATE ON public.reminder_categories FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();


--
-- Name: reminders reminders_touch_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER reminders_touch_updated_at BEFORE UPDATE ON public.reminders FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();


--
-- Name: statuses statuses_touch_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER statuses_touch_updated_at BEFORE UPDATE ON public.statuses FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();


--
-- Name: storage_units storage_units_touch_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER storage_units_touch_updated_at BEFORE UPDATE ON public.storage_units FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();


--
-- Name: supplier_categories supplier_categories_touch_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER supplier_categories_touch_updated_at BEFORE UPDATE ON public.supplier_categories FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();


--
-- Name: supplier_contacts supplier_contacts_touch_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER supplier_contacts_touch_updated_at BEFORE UPDATE ON public.supplier_contacts FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();


--
-- Name: suppliers suppliers_touch_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER suppliers_touch_updated_at BEFORE UPDATE ON public.suppliers FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();


--
-- Name: task_comments task_comments_touch_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER task_comments_touch_updated_at BEFORE UPDATE ON public.task_comments FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();


--
-- Name: task_recurrences task_recurrences_touch_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER task_recurrences_touch_updated_at BEFORE UPDATE ON public.task_recurrences FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();


--
-- Name: tasks tasks_touch_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER tasks_touch_updated_at BEFORE UPDATE ON public.tasks FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();


--
-- Name: user_permissions user_permissions_touch_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER user_permissions_touch_updated_at BEFORE UPDATE ON public.user_permissions FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();


--
-- Name: user_reminders user_reminders_touch_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER user_reminders_touch_updated_at BEFORE UPDATE ON public.user_reminders FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();


--
-- Name: users users_touch_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER users_touch_updated_at BEFORE UPDATE ON public.users FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();


--
-- Name: wa_campaigns wa_campaigns_touch; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER wa_campaigns_touch BEFORE UPDATE ON public.wa_campaigns FOR EACH ROW EXECUTE FUNCTION public.wa_touch_updated_at();


--
-- Name: wa_campaign_recipients wa_recipients_touch; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER wa_recipients_touch BEFORE UPDATE ON public.wa_campaign_recipients FOR EACH ROW EXECUTE FUNCTION public.wa_touch_updated_at();


--
-- Name: whatsapp_instances whatsapp_instances_touch_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER whatsapp_instances_touch_updated_at BEFORE UPDATE ON public.whatsapp_instances FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();


--
-- Name: whatsapp_templates whatsapp_templates_touch_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER whatsapp_templates_touch_updated_at BEFORE UPDATE ON public.whatsapp_templates FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();


--
-- Name: apartment_owner_phones apartment_owner_phones_apartment_number_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.apartment_owner_phones
    ADD CONSTRAINT apartment_owner_phones_apartment_number_fkey FOREIGN KEY (apartment_number) REFERENCES public.contacts(apartment_number) ON UPDATE CASCADE ON DELETE CASCADE;


--
-- Name: apartment_owner_phones apartment_owner_phones_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.apartment_owner_phones
    ADD CONSTRAINT apartment_owner_phones_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: apartment_owner_phones apartment_owner_phones_detached_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.apartment_owner_phones
    ADD CONSTRAINT apartment_owner_phones_detached_by_fkey FOREIGN KEY (detached_by) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: app_settings app_settings_updated_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.app_settings
    ADD CONSTRAINT app_settings_updated_by_fkey FOREIGN KEY (updated_by) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: audit_log audit_log_actor_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.audit_log
    ADD CONSTRAINT audit_log_actor_user_id_fkey FOREIGN KEY (actor_user_id) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: bllink_scrape_rows bllink_scrape_rows_scrape_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.bllink_scrape_rows
    ADD CONSTRAINT bllink_scrape_rows_scrape_id_fkey FOREIGN KEY (scrape_id) REFERENCES public.bllink_scrapes(id) ON DELETE CASCADE;


--
-- Name: calendar_event_participants calendar_event_participants_event_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.calendar_event_participants
    ADD CONSTRAINT calendar_event_participants_event_id_fkey FOREIGN KEY (event_id) REFERENCES public.calendar_events(id) ON DELETE CASCADE;


--
-- Name: calendar_events calendar_events_owner_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.calendar_events
    ADD CONSTRAINT calendar_events_owner_user_id_fkey FOREIGN KEY (owner_user_id) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: calendar_events calendar_events_parent_series_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.calendar_events
    ADD CONSTRAINT calendar_events_parent_series_id_fkey FOREIGN KEY (parent_series_id) REFERENCES public.calendar_events(id) ON DELETE CASCADE;


--
-- Name: chat_messages chat_messages_broadcast_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.chat_messages
    ADD CONSTRAINT chat_messages_broadcast_id_fkey FOREIGN KEY (broadcast_id) REFERENCES public.whatsapp_broadcasts(id) ON DELETE SET NULL;


--
-- Name: chat_messages chat_messages_debtor_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.chat_messages
    ADD CONSTRAINT chat_messages_debtor_id_fkey FOREIGN KEY (debtor_id) REFERENCES public.debtors(id) ON DELETE SET NULL;


--
-- Name: chat_messages chat_messages_instance_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.chat_messages
    ADD CONSTRAINT chat_messages_instance_id_fkey FOREIGN KEY (instance_id) REFERENCES public.whatsapp_instances(id) ON DELETE SET NULL;


--
-- Name: chat_messages chat_messages_sent_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.chat_messages
    ADD CONSTRAINT chat_messages_sent_by_fkey FOREIGN KEY (sent_by) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: chat_messages chat_messages_supplier_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.chat_messages
    ADD CONSTRAINT chat_messages_supplier_id_fkey FOREIGN KEY (supplier_id) REFERENCES public.suppliers(id) ON DELETE SET NULL;


--
-- Name: chip_events chip_events_actor_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.chip_events
    ADD CONSTRAINT chip_events_actor_id_fkey FOREIGN KEY (actor_id) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: chip_events chip_events_chip_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.chip_events
    ADD CONSTRAINT chip_events_chip_id_fkey FOREIGN KEY (chip_id) REFERENCES public.chips(id) ON DELETE CASCADE;


--
-- Name: chips chips_contact_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.chips
    ADD CONSTRAINT chips_contact_id_fkey FOREIGN KEY (contact_id) REFERENCES public.contacts(id) ON DELETE RESTRICT;


--
-- Name: chips chips_deactivated_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.chips
    ADD CONSTRAINT chips_deactivated_by_fkey FOREIGN KEY (deactivated_by) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: chips chips_issued_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.chips
    ADD CONSTRAINT chips_issued_by_fkey FOREIGN KEY (issued_by) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: comments comments_author_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.comments
    ADD CONSTRAINT comments_author_id_fkey FOREIGN KEY (author_id) REFERENCES public.users(id);


--
-- Name: comments comments_debtor_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.comments
    ADD CONSTRAINT comments_debtor_id_fkey FOREIGN KEY (debtor_id) REFERENCES public.debtors(id) ON DELETE CASCADE;


--
-- Name: completed_actions completed_actions_completed_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.completed_actions
    ADD CONSTRAINT completed_actions_completed_by_fkey FOREIGN KEY (completed_by) REFERENCES public.users(id);


--
-- Name: completed_actions completed_actions_debtor_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.completed_actions
    ADD CONSTRAINT completed_actions_debtor_id_fkey FOREIGN KEY (debtor_id) REFERENCES public.debtors(id) ON DELETE CASCADE;


--
-- Name: contact_field_sources contact_field_sources_apartment_number_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.contact_field_sources
    ADD CONSTRAINT contact_field_sources_apartment_number_fkey FOREIGN KEY (apartment_number) REFERENCES public.contacts(apartment_number) ON UPDATE CASCADE ON DELETE CASCADE;


--
-- Name: contact_people contact_people_contact_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.contact_people
    ADD CONSTRAINT contact_people_contact_id_fkey FOREIGN KEY (contact_id) REFERENCES public.contacts(id) ON DELETE CASCADE;


--
-- Name: contact_sync_suggestions contact_sync_suggestions_apartment_number_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.contact_sync_suggestions
    ADD CONSTRAINT contact_sync_suggestions_apartment_number_fkey FOREIGN KEY (apartment_number) REFERENCES public.contacts(apartment_number) ON UPDATE CASCADE ON DELETE CASCADE;


--
-- Name: contact_sync_suggestions contact_sync_suggestions_resolved_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.contact_sync_suggestions
    ADD CONSTRAINT contact_sync_suggestions_resolved_by_fkey FOREIGN KEY (resolved_by) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: contacts contacts_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.contacts
    ADD CONSTRAINT contacts_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.users(id);


--
-- Name: debtor_events debtor_events_debtor_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.debtor_events
    ADD CONSTRAINT debtor_events_debtor_id_fkey FOREIGN KEY (debtor_id) REFERENCES public.debtors(id) ON DELETE CASCADE;


--
-- Name: debtors debtors_contact_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.debtors
    ADD CONSTRAINT debtors_contact_id_fkey FOREIGN KEY (contact_id) REFERENCES public.contacts(id) ON DELETE SET NULL;


--
-- Name: debtors debtors_legal_status_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.debtors
    ADD CONSTRAINT debtors_legal_status_id_fkey FOREIGN KEY (legal_status_id) REFERENCES public.statuses(id);


--
-- Name: debtors debtors_legal_status_updated_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.debtors
    ADD CONSTRAINT debtors_legal_status_updated_by_fkey FOREIGN KEY (legal_status_updated_by) REFERENCES public.users(id);


--
-- Name: debtors_stale_import_text_backup debtors_stale_import_text_backup_debtor_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.debtors_stale_import_text_backup
    ADD CONSTRAINT debtors_stale_import_text_backup_debtor_id_fkey FOREIGN KEY (debtor_id) REFERENCES public.debtors(id) ON DELETE CASCADE;


--
-- Name: document_folders document_folders_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.document_folders
    ADD CONSTRAINT document_folders_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.users(id);


--
-- Name: document_folders document_folders_parent_folder_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.document_folders
    ADD CONSTRAINT document_folders_parent_folder_id_fkey FOREIGN KEY (parent_folder_id) REFERENCES public.document_folders(id) ON DELETE SET NULL;


--
-- Name: documents documents_folder_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.documents
    ADD CONSTRAINT documents_folder_id_fkey FOREIGN KEY (folder_id) REFERENCES public.document_folders(id) ON DELETE SET NULL;


--
-- Name: documents documents_uploaded_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.documents
    ADD CONSTRAINT documents_uploaded_by_fkey FOREIGN KEY (uploaded_by) REFERENCES public.users(id);


--
-- Name: entity_assignees entity_assignees_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.entity_assignees
    ADD CONSTRAINT entity_assignees_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: entity_assignees entity_assignees_supplier_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.entity_assignees
    ADD CONSTRAINT entity_assignees_supplier_id_fkey FOREIGN KEY (supplier_id) REFERENCES public.suppliers(id) ON DELETE CASCADE;


--
-- Name: entity_assignees entity_assignees_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.entity_assignees
    ADD CONSTRAINT entity_assignees_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: fin_categories fin_categories_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.fin_categories
    ADD CONSTRAINT fin_categories_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: fin_documents fin_documents_entry_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.fin_documents
    ADD CONSTRAINT fin_documents_entry_id_fkey FOREIGN KEY (entry_id) REFERENCES public.fin_entries(id) ON DELETE CASCADE;


--
-- Name: fin_documents fin_documents_uploaded_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.fin_documents
    ADD CONSTRAINT fin_documents_uploaded_by_fkey FOREIGN KEY (uploaded_by) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: fin_drive_connection fin_drive_connection_connected_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.fin_drive_connection
    ADD CONSTRAINT fin_drive_connection_connected_by_fkey FOREIGN KEY (connected_by) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: fin_entries fin_entries_category_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.fin_entries
    ADD CONSTRAINT fin_entries_category_id_fkey FOREIGN KEY (category_id) REFERENCES public.fin_categories(id) ON DELETE RESTRICT;


--
-- Name: fin_entries fin_entries_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.fin_entries
    ADD CONSTRAINT fin_entries_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: fin_entries fin_entries_deleted_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.fin_entries
    ADD CONSTRAINT fin_entries_deleted_by_fkey FOREIGN KEY (deleted_by) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: fin_entries fin_entries_supplier_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.fin_entries
    ADD CONSTRAINT fin_entries_supplier_id_fkey FOREIGN KEY (supplier_id) REFERENCES public.suppliers(id) ON DELETE SET NULL;


--
-- Name: fin_entries fin_entries_updated_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.fin_entries
    ADD CONSTRAINT fin_entries_updated_by_fkey FOREIGN KEY (updated_by) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: fin_settings fin_settings_updated_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.fin_settings
    ADD CONSTRAINT fin_settings_updated_by_fkey FOREIGN KEY (updated_by) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: finance_month_status finance_month_status_bank_balance_updated_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.finance_month_status
    ADD CONSTRAINT finance_month_status_bank_balance_updated_by_fkey FOREIGN KEY (bank_balance_updated_by) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: finance_month_status finance_month_status_published_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.finance_month_status
    ADD CONSTRAINT finance_month_status_published_by_fkey FOREIGN KEY (published_by) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: import_runs import_runs_initiated_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.import_runs
    ADD CONSTRAINT import_runs_initiated_by_fkey FOREIGN KEY (initiated_by) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: internal_conversation_participants internal_conversation_participants_conversation_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.internal_conversation_participants
    ADD CONSTRAINT internal_conversation_participants_conversation_id_fkey FOREIGN KEY (conversation_id) REFERENCES public.internal_conversations(id) ON DELETE CASCADE;


--
-- Name: internal_conversation_participants internal_conversation_participants_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.internal_conversation_participants
    ADD CONSTRAINT internal_conversation_participants_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: internal_conversations internal_conversations_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.internal_conversations
    ADD CONSTRAINT internal_conversations_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: internal_messages internal_messages_conversation_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.internal_messages
    ADD CONSTRAINT internal_messages_conversation_id_fkey FOREIGN KEY (conversation_id) REFERENCES public.internal_conversations(id) ON DELETE CASCADE;


--
-- Name: internal_messages internal_messages_sender_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.internal_messages
    ADD CONSTRAINT internal_messages_sender_user_id_fkey FOREIGN KEY (sender_user_id) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: issue_comments issue_comments_author_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.issue_comments
    ADD CONSTRAINT issue_comments_author_id_fkey FOREIGN KEY (author_id) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: issue_comments issue_comments_issue_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.issue_comments
    ADD CONSTRAINT issue_comments_issue_id_fkey FOREIGN KEY (issue_id) REFERENCES public.issues(id) ON DELETE CASCADE;


--
-- Name: issues issues_assigned_to_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.issues
    ADD CONSTRAINT issues_assigned_to_user_id_fkey FOREIGN KEY (assigned_to_user_id) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: issues issues_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.issues
    ADD CONSTRAINT issues_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: issues issues_reporter_contact_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.issues
    ADD CONSTRAINT issues_reporter_contact_id_fkey FOREIGN KEY (reporter_contact_id) REFERENCES public.apartment_owner_phones(id) ON DELETE SET NULL;


--
-- Name: issues_sort_order_backup issues_sort_order_backup_issue_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.issues_sort_order_backup
    ADD CONSTRAINT issues_sort_order_backup_issue_id_fkey FOREIGN KEY (issue_id) REFERENCES public.issues(id) ON DELETE CASCADE;


--
-- Name: issues issues_supplier_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.issues
    ADD CONSTRAINT issues_supplier_id_fkey FOREIGN KEY (supplier_id) REFERENCES public.suppliers(id) ON DELETE SET NULL;


--
-- Name: legal_status_history legal_status_history_changed_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.legal_status_history
    ADD CONSTRAINT legal_status_history_changed_by_fkey FOREIGN KEY (changed_by) REFERENCES public.users(id);


--
-- Name: legal_status_history legal_status_history_debtor_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.legal_status_history
    ADD CONSTRAINT legal_status_history_debtor_id_fkey FOREIGN KEY (debtor_id) REFERENCES public.debtors(id) ON DELETE CASCADE;


--
-- Name: legal_status_history legal_status_history_new_status_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.legal_status_history
    ADD CONSTRAINT legal_status_history_new_status_id_fkey FOREIGN KEY (new_status_id) REFERENCES public.statuses(id);


--
-- Name: legal_status_history legal_status_history_old_status_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.legal_status_history
    ADD CONSTRAINT legal_status_history_old_status_id_fkey FOREIGN KEY (old_status_id) REFERENCES public.statuses(id);


--
-- Name: notifications notifications_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.notifications
    ADD CONSTRAINT notifications_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: parking_spots parking_spots_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.parking_spots
    ADD CONSTRAINT parking_spots_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.users(id);


--
-- Name: parking_spots parking_spots_deactivated_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.parking_spots
    ADD CONSTRAINT parking_spots_deactivated_by_fkey FOREIGN KEY (deactivated_by) REFERENCES public.users(id);


--
-- Name: parking_spots parking_spots_updated_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.parking_spots
    ADD CONSTRAINT parking_spots_updated_by_fkey FOREIGN KEY (updated_by) REFERENCES public.users(id);


--
-- Name: password_reset_tokens password_reset_tokens_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.password_reset_tokens
    ADD CONSTRAINT password_reset_tokens_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: portal_decisions portal_decisions_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.portal_decisions
    ADD CONSTRAINT portal_decisions_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: portal_identity_apartments portal_identity_apartments_approval_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.portal_identity_apartments
    ADD CONSTRAINT portal_identity_apartments_approval_id_fkey FOREIGN KEY (approval_id) REFERENCES public.portal_identity_approvals(id) ON DELETE CASCADE;


--
-- Name: portal_identity_approvals portal_identity_approvals_decided_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.portal_identity_approvals
    ADD CONSTRAINT portal_identity_approvals_decided_by_fkey FOREIGN KEY (decided_by) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: portal_identity_approvals portal_identity_approvals_ended_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.portal_identity_approvals
    ADD CONSTRAINT portal_identity_approvals_ended_by_fkey FOREIGN KEY (ended_by) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: portal_identity_approvals portal_identity_approvals_requested_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.portal_identity_approvals
    ADD CONSTRAINT portal_identity_approvals_requested_by_fkey FOREIGN KEY (requested_by) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: portal_lockouts portal_lockouts_released_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.portal_lockouts
    ADD CONSTRAINT portal_lockouts_released_by_fkey FOREIGN KEY (released_by) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: portal_phone_entry_flags portal_phone_entry_flags_cleared_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.portal_phone_entry_flags
    ADD CONSTRAINT portal_phone_entry_flags_cleared_by_fkey FOREIGN KEY (cleared_by) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: portal_phone_entry_flags portal_phone_entry_flags_flagged_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.portal_phone_entry_flags
    ADD CONSTRAINT portal_phone_entry_flags_flagged_by_fkey FOREIGN KEY (flagged_by) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: reminder_categories reminder_categories_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.reminder_categories
    ADD CONSTRAINT reminder_categories_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.users(id);


--
-- Name: reminders reminders_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.reminders
    ADD CONSTRAINT reminders_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: renovation_fund_settings renovation_fund_settings_updated_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.renovation_fund_settings
    ADD CONSTRAINT renovation_fund_settings_updated_by_fkey FOREIGN KEY (updated_by) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: sessions sessions_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sessions
    ADD CONSTRAINT sessions_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: statuses statuses_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.statuses
    ADD CONSTRAINT statuses_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: statuses statuses_updated_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.statuses
    ADD CONSTRAINT statuses_updated_by_fkey FOREIGN KEY (updated_by) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: storage_units storage_units_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.storage_units
    ADD CONSTRAINT storage_units_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.users(id);


--
-- Name: storage_units storage_units_deactivated_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.storage_units
    ADD CONSTRAINT storage_units_deactivated_by_fkey FOREIGN KEY (deactivated_by) REFERENCES public.users(id);


--
-- Name: storage_units storage_units_updated_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.storage_units
    ADD CONSTRAINT storage_units_updated_by_fkey FOREIGN KEY (updated_by) REFERENCES public.users(id);


--
-- Name: supplier_contacts supplier_contacts_supplier_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.supplier_contacts
    ADD CONSTRAINT supplier_contacts_supplier_id_fkey FOREIGN KEY (supplier_id) REFERENCES public.suppliers(id) ON DELETE CASCADE;


--
-- Name: supplier_documents supplier_documents_supplier_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.supplier_documents
    ADD CONSTRAINT supplier_documents_supplier_id_fkey FOREIGN KEY (supplier_id) REFERENCES public.suppliers(id) ON DELETE CASCADE;


--
-- Name: suppliers suppliers_category_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.suppliers
    ADD CONSTRAINT suppliers_category_id_fkey FOREIGN KEY (category_id) REFERENCES public.supplier_categories(id) ON DELETE SET NULL;


--
-- Name: sync_runs sync_runs_import_run_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sync_runs
    ADD CONSTRAINT sync_runs_import_run_id_fkey FOREIGN KEY (import_run_id) REFERENCES public.import_runs(id) ON DELETE SET NULL;


--
-- Name: sync_runs sync_runs_triggered_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sync_runs
    ADD CONSTRAINT sync_runs_triggered_by_fkey FOREIGN KEY (triggered_by) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: task_comments task_comments_author_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.task_comments
    ADD CONSTRAINT task_comments_author_id_fkey FOREIGN KEY (author_id) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: task_comments task_comments_task_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.task_comments
    ADD CONSTRAINT task_comments_task_id_fkey FOREIGN KEY (task_id) REFERENCES public.tasks(id) ON DELETE CASCADE;


--
-- Name: task_occurrence_completions task_occurrence_completions_completed_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.task_occurrence_completions
    ADD CONSTRAINT task_occurrence_completions_completed_by_fkey FOREIGN KEY (completed_by) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: task_occurrence_completions task_occurrence_completions_recurrence_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.task_occurrence_completions
    ADD CONSTRAINT task_occurrence_completions_recurrence_id_fkey FOREIGN KEY (recurrence_id) REFERENCES public.task_recurrences(id) ON DELETE SET NULL;


--
-- Name: task_occurrence_completions task_occurrence_completions_task_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.task_occurrence_completions
    ADD CONSTRAINT task_occurrence_completions_task_id_fkey FOREIGN KEY (task_id) REFERENCES public.tasks(id) ON DELETE CASCADE;


--
-- Name: task_recurrence_exceptions task_recurrence_exceptions_recurrence_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.task_recurrence_exceptions
    ADD CONSTRAINT task_recurrence_exceptions_recurrence_id_fkey FOREIGN KEY (recurrence_id) REFERENCES public.task_recurrences(id) ON DELETE CASCADE;


--
-- Name: task_recurrences task_recurrences_task_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.task_recurrences
    ADD CONSTRAINT task_recurrences_task_id_fkey FOREIGN KEY (task_id) REFERENCES public.tasks(id) ON DELETE CASCADE;


--
-- Name: tasks tasks_assigned_to_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tasks
    ADD CONSTRAINT tasks_assigned_to_user_id_fkey FOREIGN KEY (assigned_to_user_id) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: tasks tasks_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tasks
    ADD CONSTRAINT tasks_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: tasks tasks_debtor_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tasks
    ADD CONSTRAINT tasks_debtor_id_fkey FOREIGN KEY (debtor_id) REFERENCES public.debtors(id) ON DELETE SET NULL;


--
-- Name: tasks tasks_issue_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tasks
    ADD CONSTRAINT tasks_issue_id_fkey FOREIGN KEY (issue_id) REFERENCES public.issues(id) ON DELETE SET NULL;


--
-- Name: tasks tasks_parent_task_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tasks
    ADD CONSTRAINT tasks_parent_task_id_fkey FOREIGN KEY (parent_task_id) REFERENCES public.tasks(id) ON DELETE SET NULL;


--
-- Name: tasks tasks_recurrence_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tasks
    ADD CONSTRAINT tasks_recurrence_id_fkey FOREIGN KEY (recurrence_id) REFERENCES public.task_recurrences(id) ON DELETE SET NULL;


--
-- Name: tasks tasks_supplier_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tasks
    ADD CONSTRAINT tasks_supplier_id_fkey FOREIGN KEY (supplier_id) REFERENCES public.suppliers(id) ON DELETE SET NULL;


--
-- Name: user_invites user_invites_invited_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_invites
    ADD CONSTRAINT user_invites_invited_by_fkey FOREIGN KEY (invited_by) REFERENCES public.users(id);


--
-- Name: user_permissions user_permissions_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_permissions
    ADD CONSTRAINT user_permissions_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: user_reminder_attachments user_reminder_attachments_reminder_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_reminder_attachments
    ADD CONSTRAINT user_reminder_attachments_reminder_id_fkey FOREIGN KEY (reminder_id) REFERENCES public.user_reminders(id) ON DELETE CASCADE;


--
-- Name: user_reminder_attachments user_reminder_attachments_uploaded_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_reminder_attachments
    ADD CONSTRAINT user_reminder_attachments_uploaded_by_fkey FOREIGN KEY (uploaded_by) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: user_reminder_order user_reminder_order_reminder_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_reminder_order
    ADD CONSTRAINT user_reminder_order_reminder_id_fkey FOREIGN KEY (reminder_id) REFERENCES public.user_reminders(id) ON DELETE CASCADE;


--
-- Name: user_reminder_order user_reminder_order_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_reminder_order
    ADD CONSTRAINT user_reminder_order_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: user_reminders user_reminders_assigned_to_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_reminders
    ADD CONSTRAINT user_reminders_assigned_to_fkey FOREIGN KEY (assigned_to) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: user_reminders user_reminders_category_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_reminders
    ADD CONSTRAINT user_reminders_category_id_fkey FOREIGN KEY (category_id) REFERENCES public.reminder_categories(id) ON DELETE SET NULL;


--
-- Name: user_reminders user_reminders_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_reminders
    ADD CONSTRAINT user_reminders_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.users(id);


--
-- Name: wa_campaign_attachments wa_campaign_attachments_campaign_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.wa_campaign_attachments
    ADD CONSTRAINT wa_campaign_attachments_campaign_id_fkey FOREIGN KEY (campaign_id) REFERENCES public.wa_campaigns(id) ON DELETE CASCADE;


--
-- Name: wa_campaign_recipient_apartments wa_campaign_recipient_apartments_contact_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.wa_campaign_recipient_apartments
    ADD CONSTRAINT wa_campaign_recipient_apartments_contact_id_fkey FOREIGN KEY (contact_id) REFERENCES public.contacts(id) ON DELETE RESTRICT;


--
-- Name: wa_campaign_recipient_apartments wa_campaign_recipient_apartments_recipient_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.wa_campaign_recipient_apartments
    ADD CONSTRAINT wa_campaign_recipient_apartments_recipient_id_fkey FOREIGN KEY (recipient_id) REFERENCES public.wa_campaign_recipients(id) ON DELETE CASCADE;


--
-- Name: wa_campaign_recipients wa_campaign_recipients_campaign_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.wa_campaign_recipients
    ADD CONSTRAINT wa_campaign_recipients_campaign_id_fkey FOREIGN KEY (campaign_id) REFERENCES public.wa_campaigns(id) ON DELETE CASCADE;


--
-- Name: wa_campaign_recipients wa_campaign_recipients_contact_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.wa_campaign_recipients
    ADD CONSTRAINT wa_campaign_recipients_contact_id_fkey FOREIGN KEY (contact_id) REFERENCES public.contacts(id) ON DELETE RESTRICT;


--
-- Name: wa_campaign_recipients wa_campaign_recipients_supplier_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.wa_campaign_recipients
    ADD CONSTRAINT wa_campaign_recipients_supplier_id_fkey FOREIGN KEY (supplier_id) REFERENCES public.suppliers(id) ON DELETE RESTRICT;


--
-- Name: wa_message_attachments wa_message_attachments_message_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.wa_message_attachments
    ADD CONSTRAINT wa_message_attachments_message_id_fkey FOREIGN KEY (message_id) REFERENCES public.chat_messages(id) ON DELETE CASCADE;


--
-- Name: whatsapp_broadcasts whatsapp_broadcasts_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.whatsapp_broadcasts
    ADD CONSTRAINT whatsapp_broadcasts_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: whatsapp_broadcasts whatsapp_broadcasts_instance_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.whatsapp_broadcasts
    ADD CONSTRAINT whatsapp_broadcasts_instance_id_fkey FOREIGN KEY (instance_id) REFERENCES public.whatsapp_instances(id) ON DELETE SET NULL;


--
-- Name: whatsapp_instances whatsapp_instances_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.whatsapp_instances
    ADD CONSTRAINT whatsapp_instances_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: whatsapp_templates whatsapp_templates_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.whatsapp_templates
    ADD CONSTRAINT whatsapp_templates_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- PostgreSQL database dump complete
--


--
-- Dbmate schema migrations
--

INSERT INTO public.schema_migrations (version) VALUES
    ('20000101000001'),
    ('20000101000002'),
    ('20000101000003'),
    ('20000101000004'),
    ('20000101000005'),
    ('20000101000006'),
    ('20000101000007'),
    ('20000101000008'),
    ('20000101000009'),
    ('20000101000010'),
    ('20000101000011'),
    ('20000101000012'),
    ('20000101000013'),
    ('20000101000014'),
    ('20000101000015'),
    ('20000101000016'),
    ('20000101000017'),
    ('20000101000018'),
    ('20000101000019'),
    ('20000101000020'),
    ('20000101000021'),
    ('20000101000022'),
    ('20000101000023'),
    ('20000101000024'),
    ('20000101000025'),
    ('20000101000026'),
    ('20000101000027'),
    ('20000101000028'),
    ('20000101000029'),
    ('20000101000030'),
    ('20000101000031'),
    ('20000101000032'),
    ('20000101000033'),
    ('20000101000034'),
    ('20000101000035'),
    ('20000101000036'),
    ('20000101000037'),
    ('20000101000038'),
    ('20000101000039'),
    ('20000101000040'),
    ('20000101000041'),
    ('20000101000042'),
    ('20000101000043'),
    ('20000101000044'),
    ('20000101000045'),
    ('20000101000046'),
    ('20000101000047'),
    ('20000101000048'),
    ('20000101000049'),
    ('20000101000050'),
    ('20000101000051'),
    ('20000101000052'),
    ('20000101000053'),
    ('20000101000054'),
    ('20000101000055'),
    ('20000101000056'),
    ('20000101000057'),
    ('20000101000058'),
    ('20000101000059'),
    ('20000101000060'),
    ('20000101000061'),
    ('20000101000062'),
    ('20000101000063'),
    ('20000101000064'),
    ('20000101000065'),
    ('20000101000066'),
    ('20000101000067'),
    ('20000101000068'),
    ('20000101000069'),
    ('20000101000070'),
    ('20000101000071'),
    ('20000101000072'),
    ('20000101000073'),
    ('20000101000074'),
    ('20000101000075'),
    ('20000101000076'),
    ('20000101000077'),
    ('20000101000078'),
    ('20000101000079'),
    ('20260911134305'),
    ('20260911154800'),
    ('20260913065535'),
    ('20260914170628'),
    ('20260914201005'),
    ('20260916061254'),
    ('20260916170623'),
    ('20260920221954'),
    ('20260921000521'),
    ('20260921072925'),
    ('20260921090433'),
    ('20260921171135'),
    ('20260926074117'),
    ('20260927053126'),
    ('20260927125643'),
    ('20260928175919'),
    ('20260928201600'),
    ('20260929043204'),
    ('20260929162740'),
    ('20260929194811'),
    ('20260929211433'),
    ('20260929212603'),
    ('20260930054613'),
    ('20261003074737'),
    ('20261003095149'),
    ('20261003095150'),
    ('20261003161745'),
    ('20261003161746'),
    ('20261003161747'),
    ('20261003161749'),
    ('20261003191659'),
    ('20261003202918'),
    ('20261004112133'),
    ('20261004180139'),
    ('20261005083237'),
    ('20261005210110'),
    ('20261006063651'),
    ('20261006160340'),
    ('20261009210844')
;
