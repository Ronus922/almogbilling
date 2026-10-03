-- migrate:up
-- Bllink's resident list vs the portal links, through the queue (approved
-- 03/10/2026, "סנכרון מול רשימת הדיירים של Bllink").
--
-- Three changes, one rule behind all of them: NOTHING Bllink says links a
-- phone to an apartment, or unlinks one, without a person approving it in the
-- existing queue — and every approval is logged.
--
-- 1. PEOPLE, NOT FIELDS. The scrape kept one value per apartment per role per
--    field (the primary contact). It now also keeps EVERY active person of the
--    list — role, name, phone — on the scrape itself (bllink_scrapes
--    .list_people), for all the list's apartments, not only those the debt
--    export prints. After each sync, portal_link_suggest() compares them with
--    the portal links:
--      • a phone linked to an apartment here that Bllink no longer lists in
--        it → a 'portal_unlink' suggestion;
--      • a person Bllink lists whose phone the apartment's card does not carry
--        in a portal role → a 'portal_link' suggestion with Bllink's role.
--    A rejected one does not come back for the same phone; one the facts
--    settled on their own closes as obsolete.
--
-- 2. NO PHONE IS WRITTEN STRAIGHT IN. The ingest used to fill an EMPTY field
--    from Bllink without asking — for owner_phone / tenant_phone that LINKED a
--    phone to the portal with nobody approving it. Phones now always arrive as
--    a suggestion (current value "ריק"); names and addresses keep filling an
--    empty field as before. A new apartment created from the report gets no
--    phone either — its phones are proposed in the same run.
--
-- 3. AN OWNER-NAME APPROVAL IS TWO DIFFERENT DECISIONS. Approving a new owner
--    name was always treated as an owner REPLACEMENT (the previous owner's
--    phones detached, 20261003095149) — wrong for a spelling fix. The two are
--    now separate actions with no default: 'approve_rename' (the name only)
--    and 'approve_replace' (the name, and the previous owner's phones
--    detached — contact_owner_replacement_targets() lists which, for the
--    confirmation dialog, and the approval detaches exactly those). A plain
--    'approve' (one row, or "אשר הכל") leaves such a suggestion PENDING.
--
-- Bllink exposes no "who pays" marker (Phase 0, 03/10/2026: per person only
-- the role, the name, the phone, the address, isPrimary — which up to three
-- people of one apartment carry — and isActive), so there is nothing of that
-- kind to import.
--
-- Additive: new columns and checks; the open-suggestion unique index is split
-- in two (one per kind of suggestion); the ingest and the resolver are
-- replaced (the down section restores both); two new functions.

-- ── The whole list, per person, on the scrape ───────────────────────────────
alter table public.bllink_scrapes
  add column list_people jsonb;

comment on column public.bllink_scrapes.list_people is
  'Bllink''s resident list, every ACTIVE person: {"<apartment>": [{"role": "owner"|"tenant", "name": …, "phone": …, "primary": bool}]}. Raw values. NULL when the list read failed (tenant_list_ok = false) — then nothing is compared.';

-- ── Suggestions about a person's portal link ────────────────────────────────
alter table public.contact_sync_suggestions
  add column phone_e164  text,
  add column person_role text,
  add column person_name text;

alter table public.contact_sync_suggestions
  drop constraint contact_sync_suggestions_field_check;
alter table public.contact_sync_suggestions
  add constraint contact_sync_suggestions_field_check
    check (field in ('owner_name', 'owner_phone', 'owner_email',
                     'tenant_name', 'tenant_phone', 'tenant_email',
                     'portal_link', 'portal_unlink')),
  add constraint contact_sync_suggestions_person_shape_check
    check ((field in ('portal_link', 'portal_unlink')) = (phone_e164 is not null)),
  add constraint contact_sync_suggestions_person_role_check
    check (person_role is null or person_role in ('owner', 'tenant', 'operator'));

comment on column public.contact_sync_suggestions.phone_e164 is
  'portal_link / portal_unlink only: the phone (E.164) the suggestion is about. NULL for a field suggestion.';
comment on column public.contact_sync_suggestions.person_role is
  'portal_link: Bllink''s role for the person (owner / tenant). portal_unlink: the role of the link here.';

drop index public.contact_sync_suggestions_one_open;
create unique index contact_sync_suggestions_one_open
  on public.contact_sync_suggestions (apartment_number, field)
  where status = 'pending' and phone_e164 is null;
create unique index contact_sync_suggestions_one_open_person
  on public.contact_sync_suggestions (apartment_number, field, phone_e164)
  where status = 'pending' and phone_e164 is not null;

-- ── The ingest: phones always through the queue ─────────────────────────────
create or replace function public.contact_sync_ingest(
  p_apartments text[],
  p_fields text[],
  p_values text[],
  p_may_suggest boolean[] default null
)
returns table (created integer, applied integer, suggested integer, closed integer)
language plpgsql
as $$
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

-- ── Bllink's people vs the portal links of one scrape ───────────────────────
-- Every person of one scrape's resident list, on an apartment we have. Empty
-- for a scrape that did not read the list. (Functions, not temp tables: the
-- app reaches the database through a transaction pooler.)
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

-- The apartments that scrape's list spoke about. An apartment of ours absent
-- from the list is not "everyone left" — it is no information, and nothing is
-- proposed for it.
create or replace function public.bllink_scrape_apartments(p_scrape_id uuid)
returns table (apartment_number text)
language sql
stable
as $$
  select distinct btrim(a.key)
    from public.bllink_scrapes s
    cross join lateral jsonb_each(
      case when s.tenant_list_ok and jsonb_typeof(s.list_people) = 'object'
           then s.list_people else '{}'::jsonb end) a
   where s.id = p_scrape_id
     and exists (select 1 from public.contacts c where c.apartment_number = btrim(a.key));
$$;

create or replace function public.portal_link_suggest(p_scrape_id uuid)
returns table (suggested_link integer, suggested_unlink integer, closed integer)
language plpgsql
as $$
declare
  v_link integer := 0;
  v_unlink integer := 0;
  v_closed integer := 0;
  v_n integer;
begin
  -- Close what the facts settled on their own: the card now carries the
  -- phone, or Bllink stopped listing the person.
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

  -- …the link is no longer active, or Bllink lists the phone again.
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

  -- A person Bllink lists whose phone the card does not carry in a portal
  -- role → "link?". Not when the same phone already waits as a field
  -- suggestion of that apartment (the ingest proposes the primary contacts'
  -- phones), and not when it was turned down before.
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

  -- A phone linked here that Bllink no longer lists in that apartment →
  -- "unlink?".
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

-- ── Which phones an owner REPLACEMENT detaches ──────────────────────────────
-- The previous owner's phones in the apartment: the phone the owner field holds
-- and every OWNER link recorded under the previous owner's name — except the
-- new owner's phone when the same approval sets it. One definition, read by the
-- confirmation dialog and applied by the approval.
create or replace function public.contact_owner_replacement_targets(
  p_apartment text,
  p_new_phone text
)
returns table (id uuid, phone_e164 text, owner_name text)
language sql
stable
as $$
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

-- ── Approving / rejecting ───────────────────────────────────────────────────
-- p_action:
--   'reject'          — every pending id, rejected;
--   'approve'         — every pending id EXCEPT an owner-name change of a
--                       non-empty name (that one needs a choice and stays
--                       pending). With SEVERAL ids ("אשר הכל") only what does
--                       not change portal access: a phone, a link and an
--                       unlink are approved one by one and stay pending here;
--   'approve_rename'  — ONE owner-name change, as a NAME FIX: the name only,
--                       no phone detached;
--   'approve_replace' — ONE owner-name change, as an OWNER REPLACEMENT: the
--                       previous owner's phones detached, and the pending
--                       owner-phone suggestion of the same apartment (the new
--                       owner's phone) approved with it.
-- An owner-phone suggestion waits while an owner-name CHANGE of its apartment
-- is pending: approving the phone first would put the new owner's phone under
-- the old owner's name, and a later replacement would detach it.
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
-- The resolver and the ingest of 20261003095149 / 20260930054613 back; the
-- person suggestions are closed (obsolete) before their kind disappears.
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

drop function if exists public.contact_owner_replacement_targets(text, text);
drop function if exists public.portal_link_suggest(uuid);
drop function if exists public.bllink_scrape_apartments(uuid);
drop function if exists public.bllink_scrape_people(uuid);

create or replace function public.contact_sync_ingest(
  p_apartments text[],
  p_fields text[],
  p_values text[],
  p_may_suggest boolean[] default null
)
returns table (created integer, applied integer, suggested integer, closed integer)
language plpgsql
as $$
declare
  v_created integer := 0;
  v_applied integer := 0;
  v_suggested integer := 0;
  v_closed integer := 0;
  v_n integer;
begin
  perform set_config('app.write_source', 'bllink', true);

  insert into public.contacts (apartment_number, owner_name, owner_phone, owner_email,
                               tenant_name, tenant_phone, tenant_email, source, needs_review)
  select a.apt,
         max(i.value) filter (where i.field = 'owner_name'),
         max(i.value) filter (where i.field = 'owner_phone'),
         max(i.value) filter (where i.field = 'owner_email'),
         max(i.value) filter (where i.field = 'tenant_name'),
         max(i.value) filter (where i.field = 'tenant_phone'),
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

  update public.contacts c set owner_name = i.value
    from public.contact_sync_incoming(p_apartments, p_fields, p_values, p_may_suggest) i
   where c.apartment_number = i.apartment_number and i.field = 'owner_name'
     and nullif(btrim(coalesce(c.owner_name, '')), '') is null;
  get diagnostics v_n = row_count; v_applied := v_applied + v_n;

  update public.contacts c set owner_phone = i.value
    from public.contact_sync_incoming(p_apartments, p_fields, p_values, p_may_suggest) i
   where c.apartment_number = i.apartment_number and i.field = 'owner_phone'
     and nullif(btrim(coalesce(c.owner_phone, '')), '') is null;
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

  update public.contacts c set tenant_phone = i.value
    from public.contact_sync_incoming(p_apartments, p_fields, p_values, p_may_suggest) i
   where c.apartment_number = i.apartment_number and i.field = 'tenant_phone'
     and nullif(btrim(coalesce(c.tenant_phone, '')), '') is null;
  get diagnostics v_n = row_count; v_applied := v_applied + v_n;

  update public.contacts c set tenant_email = i.value
    from public.contact_sync_incoming(p_apartments, p_fields, p_values, p_may_suggest) i
   where c.apartment_number = i.apartment_number and i.field = 'tenant_email'
     and nullif(btrim(coalesce(c.tenant_email, '')), '') is null;
  get diagnostics v_n = row_count; v_applied := v_applied + v_n;

  update public.contact_sync_suggestions s
     set status = 'obsolete', resolved_at = now()
    from public.contacts c
   where s.status = 'pending'
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

  update public.contact_sync_suggestions s
     set status = 'obsolete', resolved_at = now()
    from public.contact_sync_incoming(p_apartments, p_fields, p_values, p_may_suggest) i
    join public.contacts c on c.apartment_number = i.apartment_number
   where s.status = 'pending'
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
   where nullif(btrim(coalesce(cur.v, '')), '') is not null
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
  on conflict (apartment_number, field) where status = 'pending'
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

update public.contact_sync_suggestions
   set status = 'obsolete', resolved_at = coalesce(resolved_at, now())
 where field in ('portal_link', 'portal_unlink') and status = 'pending';
-- Resolved person suggestions cannot stay under a field the old check does
-- not know: they go (they are history of a feature this down removes; the
-- audit_log rows of every approval stay).
delete from public.contact_sync_suggestions where field in ('portal_link', 'portal_unlink');

drop index if exists public.contact_sync_suggestions_one_open_person;
drop index if exists public.contact_sync_suggestions_one_open;
create unique index contact_sync_suggestions_one_open
  on public.contact_sync_suggestions (apartment_number, field) where status = 'pending';

alter table public.contact_sync_suggestions
  drop constraint if exists contact_sync_suggestions_person_role_check,
  drop constraint if exists contact_sync_suggestions_person_shape_check,
  drop constraint contact_sync_suggestions_field_check;
alter table public.contact_sync_suggestions
  add constraint contact_sync_suggestions_field_check
    check (field in ('owner_name', 'owner_phone', 'owner_email',
                     'tenant_name', 'tenant_phone', 'tenant_email'));
alter table public.contact_sync_suggestions
  drop column if exists person_name,
  drop column if exists person_role,
  drop column if exists phone_e164;

alter table public.bllink_scrapes drop column if exists list_people;
