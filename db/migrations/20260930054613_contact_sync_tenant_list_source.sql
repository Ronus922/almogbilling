-- migrate:up
-- Names and phones move to Bllink's resident list; the debt export keeps the
-- money (Ronen's decision, 30/09/2026, on the recommendation in PR #52).
--
-- The export carries ONE name cell and ONE phone cell per apartment, holding
-- whichever single person Bllink chose to print, behind "(בעלים)" /
-- "(שוכר/ת)" labels that are sometimes missing altogether. Very often that
-- person is the tenant and the owner is simply absent: on the snapshot of
-- 30/09/2026, 53 of 219 apartments name NO owner there while the resident
-- list knows one. The list — which has supplied the addresses since
-- yesterday — holds one entry per PERSON with an explicit role and a
-- primary-contact flag: 284 owner names, 280 owner phones, 158 tenant names
-- and 157 tenant phones over 290 apartments.
--
-- A correction to PR #52's report while we are here: it said the export
-- TRUNCATES names, on the strength of apartment 514's
-- "' אפרטמנטס- טלי אראל". It does not. That name is truncated in Bllink's
-- own record and the resident list reads exactly the same — the export was
-- carrying it faithfully. The case for the switch is the missing role, not a
-- cut string.
--
-- Three things change here, and the seven rules do not:
--
-- 1. THE SNAPSHOT keeps the resident list's own cells beside the export's, so
--    one morning is still one row and the fallback below can be decided per
--    field. The two address columns added yesterday join them under one name.
--
-- 2. A SUGGESTION CAN BE MUTED. The resident-list read is best-effort — the
--    debt figures are what the scrape exists for — so a sync that lost it
--    falls back to the export for names and phones. Filling an EMPTY field
--    from a second-best value is still worth doing; ASKING about one is not,
--    because in the export which role a name belongs to is a guess, and a
--    question built on a guess is noise someone clears by hand. The caller
--    marks those entries and the queue stays quiet about them.
--
-- 3. A SUGGESTION CLOSES WHEN THE SOURCE WITHDRAWS IT. Until now a proposal
--    only closed when OUR value moved to meet it. A proposal the source
--    itself stopped making stayed open for ever — and changing the source
--    under a queue that is already full of the old source's questions is
--    exactly when that matters. Now: the source agrees with us, so there is
--    nothing to decide, and the row closes as `obsolete` like the other case.

-- ── The snapshot: the resident list's cells beside the export's ────────────
-- `list_*` is what Bllink's resident list said; owner_name / phone_primary
-- stay the export's RAW cells, so a sync that lost the list still has
-- something to fall back to and the choice can be seen after the fact.
-- The two address columns of 20260929212603 join the same naming.
alter table public.bllink_scrape_rows rename column owner_email to list_owner_email;
alter table public.bllink_scrape_rows rename column tenant_email to list_tenant_email;
alter table public.bllink_scrape_rows
  add column list_owner_name text,
  add column list_owner_phone text,
  add column list_tenant_name text,
  add column list_tenant_phone text;

comment on column public.bllink_scrape_rows.list_owner_name is
  'From Bllink''s resident list, raw. NULL when that read failed — the scrape does not fail with it, and the sync falls back to the export''s labelled name cell for that run.';

alter table public.bllink_scrapes
  add column tenant_list_ok boolean not null default false;

comment on column public.bllink_scrapes.tenant_list_ok is
  'Did this scrape manage to read the resident list? false = names and phones in it came from the debt export alone.';

-- Yesterday's scrapes did read it — they are the ones that have addresses.
update public.bllink_scrapes s
   set tenant_list_ok = true
 where exists (select 1 from public.bllink_scrape_rows r
                where r.scrape_id = s.id and r.list_owner_email is not null);

-- ── Comparing two values the way a human would ──────────────────────────────
-- Unchanged except for one thing the live data taught us: an invisible
-- bidirectional mark (U+200E/U+200F/U+202A-E, and the zero-width family) is
-- not whitespace, so btrim leaves it in place and two values that read
-- IDENTICALLY on screen compared as different — a suggestion nobody could
-- act on, because approving it would change nothing visible. Found on
-- apartment 1033, whose stored address carries a trailing U+202C.
create or replace function public.contact_value_norm(p_field text, raw text)
returns text
language plpgsql
immutable
as $$
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

-- ── The field set ───────────────────────────────────────────────────────────
alter table public.contact_sync_suggestions
  drop constraint contact_sync_suggestions_field_check;
alter table public.contact_sync_suggestions
  add constraint contact_sync_suggestions_field_check
  check (field in ('owner_name', 'owner_phone', 'owner_email',
                   'tenant_name', 'tenant_phone', 'tenant_email'));

alter table public.contact_field_sources
  drop constraint contact_field_sources_field_check;
alter table public.contact_field_sources
  add constraint contact_field_sources_field_check
  check (field in ('owner_name', 'owner_phone', 'owner_email',
                   'tenant_name', 'tenant_phone', 'tenant_email'));

-- ── The trigger: provenance, and closing a suggestion that settled itself ───
create or replace function public.contacts_field_provenance()
returns trigger
language plpgsql
as $$
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

drop trigger if exists contacts_field_provenance_aiu on public.contacts;
create trigger contacts_field_provenance_aiu
  after insert or update of owner_name, owner_phone, owner_email,
                            tenant_name, tenant_phone, tenant_email
  on public.contacts
  for each row execute function public.contacts_field_provenance();

-- ── What one sync hands over ────────────────────────────────────────────────
-- The report ALREADY unpivoted: one entry per apartment+field, blanks dropped,
-- unknown field names dropped, and at most one row per pair (a workbook can
-- carry the same apartment twice, and an ON CONFLICT statement cannot touch
-- the same row twice).
drop function if exists public.contact_sync_incoming(text[], text[], text[]);
create or replace function public.contact_sync_incoming(
  p_apartments text[],
  p_fields text[],
  p_values text[],
  p_may_suggest boolean[] default null
)
returns table (apartment_number text, field text, value text, may_suggest boolean)
language sql
immutable
as $$
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

-- ── The whole rule, in one place ────────────────────────────────────────────
-- Per apartment+field Bllink supplies:
--   • apartment we do not have      → created from the report, as before;
--   • same value (after norm)       → nothing;
--   • ours empty, theirs has a value→ written straight in (nothing to overwrite);
--   • ours set and theirs differs   → a pending suggestion, and OURS STANDS;
--   • theirs empty                  → nothing, ours stands (unchanged);
--   • that exact value was rejected → nothing, until Bllink changes it again;
--   • an open suggestion ours now matches → closed as obsolete.
drop function if exists public.contact_sync_ingest(text[], text[], text[]);
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
  -- Everything this function writes to contacts came from Bllink. Transaction
  -- local; cleared before returning.
  perform set_config('app.write_source', 'bllink', true);

  -- 1. Apartments missing from the registry, exactly as before: created with
  --    whatever the report knows, flagged for review, never an UPDATE. Driven
  --    by the APARTMENT list and not by the field rows, because an apartment
  --    whose every contact cell is blank still has to exist.
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

  -- 2. Fields we simply do not have. No approval: there is nothing to overwrite.
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

  -- 3. Open suggestions the live value already satisfies. The trigger closes
  --    these the moment the value is typed; this is the safety net for rows
  --    that predate it or that changed outside a trigger's reach.
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

  -- 3b. Open questions the SOURCE has stopped asking. Until 30/09/2026 a
  --     suggestion only closed when OUR value moved to meet it; a proposal
  --     the source itself withdrew stayed open for ever. It withdrew plenty
  --     the day the names moved to the resident list. Nobody should have to
  --     reject a proposal that nothing is making any more.
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

  -- 4. The conflicts. Ours stands; the difference waits for a decision.
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
     -- A value the caller flagged as second-best (the resident list was
     -- unreachable and this came from the truncating export) fills an empty
     -- field but never ASKS anything: a suggestion is a question put to a
     -- person, and a question built on a value we already distrust is noise.
     and i.may_suggest
     and public.contact_value_norm(i.field, cur.v)
         is distinct from public.contact_value_norm(i.field, i.value)
     -- A value that was turned down does not come back. It returns only when
     -- Bllink itself changes to something else.
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
   -- An unchanged proposal keeps its original date: the second sync of the day
   -- must not make yesterday's suggestion look new.
   where public.contact_value_norm(public.contact_sync_suggestions.field,
                                   public.contact_sync_suggestions.proposed_value)
         is distinct from public.contact_value_norm(excluded.field, excluded.proposed_value);
  get diagnostics v_suggested = row_count;

  perform set_config('app.write_source', '', true);

  created := v_created; applied := v_applied; suggested := v_suggested; closed := v_closed;
  return next;
end;
$$;

-- ── Approving / rejecting ───────────────────────────────────────────────────
create or replace function public.contact_suggestion_resolve(
  p_ids uuid[],
  p_action text,
  p_actor uuid
)
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

-- (20260929212603 also ADDED the two address columns here. This migration's
--  DOWN renamed them back into place a few statements ago, so re-adding them
--  would fail — the block is deliberately absent.)

-- migrate:down
alter table public.bllink_scrape_rows
  drop column if exists list_owner_name,
  drop column if exists list_owner_phone,
  drop column if exists list_tenant_name,
  drop column if exists list_tenant_phone;
alter table public.bllink_scrape_rows rename column list_owner_email to owner_email;
alter table public.bllink_scrape_rows rename column list_tenant_email to tenant_email;
alter table public.bllink_scrapes drop column if exists tenant_list_ok;

drop function if exists public.contact_sync_ingest(text[], text[], text[], boolean[]);
drop function if exists public.contact_sync_incoming(text[], text[], text[], boolean[]);

-- ── Comparing two values the way a human would ──────────────────────────────
-- Unchanged except for one thing the live data taught us: an invisible
-- bidirectional mark (U+200E/U+200F/U+202A-E, and the zero-width family) is
-- not whitespace, so btrim leaves it in place and two values that read
-- IDENTICALLY on screen compared as different — a suggestion nobody could
-- act on, because approving it would change nothing visible. Found on
-- apartment 1033, whose stored address carries a trailing U+202C.
create or replace function public.contact_value_norm(p_field text, raw text)
returns text
language plpgsql
immutable
as $$
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

-- ── The field set ───────────────────────────────────────────────────────────
alter table public.contact_sync_suggestions
  drop constraint contact_sync_suggestions_field_check;
alter table public.contact_sync_suggestions
  add constraint contact_sync_suggestions_field_check
  check (field in ('owner_name', 'owner_phone', 'owner_email',
                   'tenant_name', 'tenant_phone', 'tenant_email'));

alter table public.contact_field_sources
  drop constraint contact_field_sources_field_check;
alter table public.contact_field_sources
  add constraint contact_field_sources_field_check
  check (field in ('owner_name', 'owner_phone', 'owner_email',
                   'tenant_name', 'tenant_phone', 'tenant_email'));

-- ── The trigger: provenance, and closing a suggestion that settled itself ───
create or replace function public.contacts_field_provenance()
returns trigger
language plpgsql
as $$
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

drop trigger if exists contacts_field_provenance_aiu on public.contacts;
create trigger contacts_field_provenance_aiu
  after insert or update of owner_name, owner_phone, owner_email,
                            tenant_name, tenant_phone, tenant_email
  on public.contacts
  for each row execute function public.contacts_field_provenance();

-- ── What one sync hands over ────────────────────────────────────────────────
-- The report ALREADY unpivoted: one entry per apartment+field, blanks dropped,
-- unknown field names dropped, and at most one row per pair (a workbook can
-- carry the same apartment twice, and an ON CONFLICT statement cannot touch
-- the same row twice).
drop function if exists public.contact_sync_incoming(text[], text[], text[], text[]);
create or replace function public.contact_sync_incoming(
  p_apartments text[],
  p_fields text[],
  p_values text[]
)
returns table (apartment_number text, field text, value text)
language sql
immutable
as $$
  select distinct on (btrim(t.a), t.f) btrim(t.a), t.f, btrim(t.v)
    from unnest(p_apartments, p_fields, p_values) as t(a, f, v)
   where btrim(coalesce(t.a, '')) <> ''
     and t.f = any (array['owner_name', 'owner_phone', 'owner_email',
                          'tenant_name', 'tenant_phone', 'tenant_email'])
     and nullif(btrim(coalesce(t.v, '')), '') is not null
   order by btrim(t.a), t.f;
$$;

-- ── The whole rule, in one place ────────────────────────────────────────────
-- Per apartment+field Bllink supplies:
--   • apartment we do not have      → created from the report, as before;
--   • same value (after norm)       → nothing;
--   • ours empty, theirs has a value→ written straight in (nothing to overwrite);
--   • ours set and theirs differs   → a pending suggestion, and OURS STANDS;
--   • theirs empty                  → nothing, ours stands (unchanged);
--   • that exact value was rejected → nothing, until Bllink changes it again;
--   • an open suggestion ours now matches → closed as obsolete.
drop function if exists public.contact_sync_ingest(text[], text[], text[], text[]);
create or replace function public.contact_sync_ingest(
  p_apartments text[],
  p_fields text[],
  p_values text[]
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
  -- Everything this function writes to contacts came from Bllink. Transaction
  -- local; cleared before returning.
  perform set_config('app.write_source', 'bllink', true);

  -- 1. Apartments missing from the registry, exactly as before: created with
  --    whatever the report knows, flagged for review, never an UPDATE. Driven
  --    by the APARTMENT list and not by the field rows, because an apartment
  --    whose every contact cell is blank still has to exist.
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
    left join public.contact_sync_incoming(p_apartments, p_fields, p_values) i
           on i.apartment_number = a.apt
   group by a.apt
  on conflict (apartment_number) do nothing;
  get diagnostics v_created = row_count;

  -- 2. Fields we simply do not have. No approval: there is nothing to overwrite.
  update public.contacts c set owner_name = i.value
    from public.contact_sync_incoming(p_apartments, p_fields, p_values) i
   where c.apartment_number = i.apartment_number and i.field = 'owner_name'
     and nullif(btrim(coalesce(c.owner_name, '')), '') is null;
  get diagnostics v_n = row_count; v_applied := v_applied + v_n;

  update public.contacts c set owner_phone = i.value
    from public.contact_sync_incoming(p_apartments, p_fields, p_values) i
   where c.apartment_number = i.apartment_number and i.field = 'owner_phone'
     and nullif(btrim(coalesce(c.owner_phone, '')), '') is null;
  get diagnostics v_n = row_count; v_applied := v_applied + v_n;

  update public.contacts c set owner_email = i.value
    from public.contact_sync_incoming(p_apartments, p_fields, p_values) i
   where c.apartment_number = i.apartment_number and i.field = 'owner_email'
     and nullif(btrim(coalesce(c.owner_email, '')), '') is null;
  get diagnostics v_n = row_count; v_applied := v_applied + v_n;

  update public.contacts c set tenant_name = i.value
    from public.contact_sync_incoming(p_apartments, p_fields, p_values) i
   where c.apartment_number = i.apartment_number and i.field = 'tenant_name'
     and nullif(btrim(coalesce(c.tenant_name, '')), '') is null;
  get diagnostics v_n = row_count; v_applied := v_applied + v_n;

  update public.contacts c set tenant_phone = i.value
    from public.contact_sync_incoming(p_apartments, p_fields, p_values) i
   where c.apartment_number = i.apartment_number and i.field = 'tenant_phone'
     and nullif(btrim(coalesce(c.tenant_phone, '')), '') is null;
  get diagnostics v_n = row_count; v_applied := v_applied + v_n;

  update public.contacts c set tenant_email = i.value
    from public.contact_sync_incoming(p_apartments, p_fields, p_values) i
   where c.apartment_number = i.apartment_number and i.field = 'tenant_email'
     and nullif(btrim(coalesce(c.tenant_email, '')), '') is null;
  get diagnostics v_n = row_count; v_applied := v_applied + v_n;

  -- 3. Open suggestions the live value already satisfies. The trigger closes
  --    these the moment the value is typed; this is the safety net for rows
  --    that predate it or that changed outside a trigger's reach.
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

  -- 4. The conflicts. Ours stands; the difference waits for a decision.
  insert into public.contact_sync_suggestions
    (apartment_number, field, current_value, proposed_value, source)
  select i.apartment_number, i.field, cur.v, i.value, 'bllink'
    from public.contact_sync_incoming(p_apartments, p_fields, p_values) i
    join public.contacts c on c.apartment_number = i.apartment_number
    cross join lateral (select case i.field
                                 when 'owner_name'   then c.owner_name
                                 when 'owner_phone'  then c.owner_phone
                                 when 'owner_email'  then c.owner_email
                                 when 'tenant_name'  then c.tenant_name
                                 when 'tenant_phone' then c.tenant_phone
                                 else c.tenant_email end as v) cur
   where nullif(btrim(coalesce(cur.v, '')), '') is not null
     and public.contact_value_norm(i.field, cur.v)
         is distinct from public.contact_value_norm(i.field, i.value)
     -- A value that was turned down does not come back. It returns only when
     -- Bllink itself changes to something else.
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
   -- An unchanged proposal keeps its original date: the second sync of the day
   -- must not make yesterday's suggestion look new.
   where public.contact_value_norm(public.contact_sync_suggestions.field,
                                   public.contact_sync_suggestions.proposed_value)
         is distinct from public.contact_value_norm(excluded.field, excluded.proposed_value);
  get diagnostics v_suggested = row_count;

  perform set_config('app.write_source', '', true);

  created := v_created; applied := v_applied; suggested := v_suggested; closed := v_closed;
  return next;
end;
$$;

-- ── Approving / rejecting ───────────────────────────────────────────────────
create or replace function public.contact_suggestion_resolve(
  p_ids uuid[],
  p_action text,
  p_actor uuid
)
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

-- (20260929212603 also ADDED the two address columns here. This DOWN renamed
--  them back into place a few statements ago, so re-adding them would fail —
--  the block is deliberately absent.)
