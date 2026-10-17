-- migrate:up
-- One phone, several apartments, one decision (17/10/2026, "פישוט גישת
-- פורטל" — see decisions log and PROJECT_CONTEXT.md).
--
-- A management company or a multi-unit landlord shows up in Bllink's
-- resident list once per apartment, so portal_link_suggest() (migration
-- 20261003161749) raises ONE 'portal_link'/'portal_unlink' suggestion PER
-- apartment for the same phone. Approving used to mean clicking "שייך"
-- apartment by apartment — nothing enforced it, the queue just never grouped
-- them. From here the screen groups a phone's suggestions on one field and
-- resolves them together, in ONE call with every id.
--
-- That call must not fall under "אשר הכל" (p_ids with cardinality > 1 on
-- 'approve') — the existing rule never lets a bulk call touch portal access,
-- precisely because a human bundling unrelated rows by convenience should
-- not be deciding several different people's access in one click. A group
-- that is the SAME phone on the SAME access field is not that: it is one
-- decision repeated across the apartments it already applies to. The only
-- change here is telling the two apart.
--
-- Additive in spirit — no column, no table — but the function is replaced
-- (the down section restores the exact 03/10/2026 body).
create or replace function public.contact_suggestion_resolve(p_ids uuid[], p_action text, p_actor uuid)
returns integer
language plpgsql
as $$
declare
  v_now timestamptz := clock_timestamp();
  v_n integer;
  v_mode text;
  v_bulk boolean;
  v_same_phone_group boolean;
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

  -- One phone's own several apartments, on the same access field: not a
  -- bundle of unrelated decisions, so the bulk-never-touches-access guard
  -- below does not apply to it.
  select count(distinct s.field) = 1 and count(distinct s.phone_e164) = 1
         and bool_and(s.field in ('portal_link', 'portal_unlink')) and bool_and(s.phone_e164 is not null)
    into v_same_phone_group
    from public.contact_sync_suggestions s
   where s.id = any(p_ids);
  v_bulk := p_action = 'approve' and cardinality(p_ids) > 1 and not coalesce(v_same_phone_group, false);

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

-- migrate:down
-- The 03/10/2026 body (migration 20261003161749), v_bulk unconditional on
-- cardinality again — no same-phone grouping exception.
create or replace function public.contact_suggestion_resolve(p_ids uuid[], p_action text, p_actor uuid)
returns integer
language plpgsql
as $$
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

  if v_mode = 'replace' then
    v_ids := v_ids || array(
      select sp.id
        from public.contact_sync_suggestions sn
        join public.contact_sync_suggestions sp
          on sp.apartment_number = sn.apartment_number
         and sp.field = 'owner_phone' and sp.status = 'pending'
       where sn.id = any(p_ids) and sn.field = 'owner_name' and sn.status = 'pending');
  end if;

  update public.contact_sync_suggestions s
     set status = case when p_action = 'reject' then 'rejected' else 'approved' end,
         resolved_at = v_now,
         resolved_by = p_actor
    from public.contacts c
   where s.id = any(v_ids) and s.status = 'pending'
     and c.apartment_number = s.apartment_number
     and (p_action = 'reject'
          or (
              (v_mode is null
               or s.field = 'owner_name'
               or (v_mode = 'replace' and s.field = 'owner_phone'))
              and (v_mode is not null
                   or not (s.field = 'owner_name'
                           and nullif(btrim(coalesce(c.owner_name, '')), '') is not null
                           and public.contact_value_norm('owner_name', c.owner_name)
                               is distinct from public.contact_value_norm('owner_name', s.proposed_value)))
              and not (v_bulk and s.field in ('owner_phone', 'tenant_phone', 'portal_link', 'portal_unlink'))
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

    insert into public.audit_log (actor_user_id, action, entity_type, entity_id, metadata)
    select p_actor, 'contact_owner_name_approved', 'contact_sync_suggestion', s.id::text,
           jsonb_build_object('apartment_number', s.apartment_number,
                              'from', s.current_value, 'to', s.proposed_value,
                              'mode', coalesce(v_mode, 'fill'))
      from public.contact_sync_suggestions s
     where s.id = any(v_ids) and s.resolved_at = v_now and s.field = 'owner_name';

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
          null;
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
