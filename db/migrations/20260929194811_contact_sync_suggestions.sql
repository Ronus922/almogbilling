-- migrate:up
-- Bllink PROPOSES, Ronen APPROVES — the residents list stops being overwritten.
--
-- What was true until today: the debt pipeline (the Bllink sync AND the Excel
-- import — importParsedRows is shared) reached public.contacts through exactly
-- one call, ensureContactsForApartments: INSERT … ON CONFLICT DO NOTHING. A
-- MISSING apartment was created from the report; an EXISTING apartment was
-- never touched, not even an empty field (commit b88910d, 08/08/2026). That is
-- the "switch-off" — it is the shape of the call, not a flag or a setting, and
-- there is nothing to remove.
--
-- It cost what a blanket switch-off costs: when a phone changed in Bllink,
-- nobody here ever heard about it.
--
-- From here the two writers split: a value we do not have is filled silently
-- (there is nothing to overwrite), and a value that CONFLICTS with ours becomes
-- a pending suggestion. Nothing about money changes — total_debt,
-- management_fees, hot_water_debt, monthly_debt and details keep being written
-- straight to public.debtors exactly as before.
--
-- Bllink supplies three contact fields and no more: owner_name, and the single
-- phone_primary cell split into an owner and a tenant number
-- (splitOwnerTenantPhones, src/lib/sync/bllinkMap.ts). No email, no tenant
-- name, no operator — so the CHECKs below name those three and nothing else.

-- ── Comparing two values the way a human would ──────────────────────────────
-- Used by every decision here: "0541234567" and "+972-54-123-4567" are the same
-- number, and "רונן  משולם " and "רונן משולם" are the same name. Deliberately
-- looser than toPortalE164(): this rule only has to decide whether a value
-- CHANGED, so it must not reject a landline or a foreign number — rejecting one
-- would silently propose it again every single morning.
create or replace function public.contact_value_norm(p_field text, raw text)
returns text
language plpgsql
immutable
as $$
declare
  first_part text;
  digits text;
begin
  if raw is null then return null; end if;

  if p_field in ('owner_phone', 'tenant_phone') then
    -- A cell can hold two numbers ("054… / 050…") — the first one is the value,
    -- exactly as splitOwnerTenantPhones() and normalizePhone() read it.
    first_part := btrim(split_part(regexp_replace(raw, '[/,;|]', '/', 'g'), '/', 1));
    digits := regexp_replace(first_part, '\D', '', 'g');
    if digits = '' then return null; end if;
    if left(digits, 2) = '00' then digits := substr(digits, 3); end if;
    if left(digits, 3) = '972' then digits := '0' || substr(digits, 4); end if;
    return digits;
  end if;

  return nullif(lower(btrim(regexp_replace(raw, '\s+', ' ', 'g'))), '');
end;
$$;

comment on function public.contact_value_norm(text, text) is
  'Equality rule for the resident-list fields Bllink supplies. Phones compare as local digits, names case- and whitespace-insensitively. Never rejects a value — it only decides whether two values differ.';

-- ── The queue ───────────────────────────────────────────────────────────────
create table public.contact_sync_suggestions (
  id uuid primary key default gen_random_uuid(),
  apartment_number text not null
    references public.contacts(apartment_number) on update cascade on delete cascade,
  field text not null check (field in ('owner_name', 'owner_phone', 'tenant_phone')),
  -- What we held when the suggestion was raised. KEPT for the record; the
  -- screens read the live value out of contacts, because ours may have moved on
  -- to a third value since.
  current_value text,
  proposed_value text not null,
  source text not null default 'bllink' check (source in ('bllink')),
  status text not null default 'pending'
    check (status in ('pending', 'approved', 'rejected', 'obsolete')),
  created_at timestamptz not null default now(),
  resolved_at timestamptz,
  resolved_by uuid references public.users(id) on delete set null,
  constraint contact_sync_suggestions_resolution_shape check (
    (status = 'pending' and resolved_at is null) or
    (status <> 'pending' and resolved_at is not null))
);

comment on table public.contact_sync_suggestions is
  'Bllink proposals for the resident list. One OPEN row per apartment+field; approved / rejected / obsolete rows are history. obsolete = the local value changed by itself and now matches the proposal, so there was nothing left to decide.';
comment on column public.contact_sync_suggestions.resolved_by is
  'The user who pressed approve/reject. NULL on an obsolete row — nobody decided it.';

-- One OPEN suggestion per apartment+field. The whole mechanism leans on this:
-- two syncs in a row cannot leave two rows behind.
create unique index contact_sync_suggestions_one_open
  on public.contact_sync_suggestions (apartment_number, field)
  where status = 'pending';

-- The queue the screen reads, newest first.
create index contact_sync_suggestions_pending_idx
  on public.contact_sync_suggestions (created_at desc)
  where status = 'pending';

-- "Was this exact value already turned down?" — asked once per incoming field
-- on every sync.
create index contact_sync_suggestions_rejected_idx
  on public.contact_sync_suggestions (apartment_number, field)
  where status = 'rejected';

-- ── Who wrote each field, and when ──────────────────────────────────────────
-- A table rather than six columns on contacts: the key is the same
-- (apartment, field) the queue uses, so the screens read both with one shape,
-- and a field nobody ever touched simply has no row.
create table public.contact_field_sources (
  apartment_number text not null
    references public.contacts(apartment_number) on update cascade on delete cascade,
  field text not null check (field in ('owner_name', 'owner_phone', 'tenant_phone')),
  source text not null check (source in ('manual', 'bllink')),
  updated_at timestamptz not null default now(),
  primary key (apartment_number, field)
);

comment on table public.contact_field_sources is
  'Provenance of the resident-list fields Bllink also supplies: who last CHANGED each one. Written by a trigger, so no call site can forget.';

-- ── The trigger: provenance, and closing a suggestion that settled itself ───
-- Manual is the DEFAULT, on purpose: every screen, route, script and hand
-- written UPDATE counts as manual, and only a writer that explicitly declares
-- itself (set_config('app.write_source','bllink')) is recorded otherwise. A new
-- write path therefore lands on the safe answer without knowing this exists.
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
  foreach f in array array['owner_name', 'owner_phone', 'tenant_phone'] loop
    new_v := case f
               when 'owner_name'  then new.owner_name
               when 'owner_phone' then new.owner_phone
               else new.tenant_phone end;
    old_v := case
               when tg_op = 'INSERT' then null
               when f = 'owner_name'  then old.owner_name
               when f = 'owner_phone' then old.owner_phone
               else old.tenant_phone end;

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

create trigger contacts_field_provenance_aiu
  after insert or update of owner_name, owner_phone, tenant_phone
  on public.contacts
  for each row execute function public.contacts_field_provenance();

-- ── What one sync hands over ────────────────────────────────────────────────
-- The report, unpivoted to one row per apartment+field, blanks dropped and at
-- most one row per pair (a workbook can carry the same apartment twice, and an
-- ON CONFLICT statement cannot touch the same row twice).
create or replace function public.contact_sync_incoming(
  p_apartments text[],
  p_owner_names text[],
  p_owner_phones text[],
  p_tenant_phones text[]
)
returns table (apartment_number text, field text, value text)
language sql
immutable
as $$
  select distinct on (btrim(t.a), f.n) btrim(t.a), f.n, btrim(f.v)
    from unnest(p_apartments, p_owner_names, p_owner_phones, p_tenant_phones)
           as t(a, onm, oph, tph)
    cross join lateral (values ('owner_name', t.onm),
                               ('owner_phone', t.oph),
                               ('tenant_phone', t.tph)) as f(n, v)
   where btrim(coalesce(t.a, '')) <> ''
     and nullif(btrim(coalesce(f.v, '')), '') is not null
   order by btrim(t.a), f.n;
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
create or replace function public.contact_sync_ingest(
  p_apartments text[],
  p_owner_names text[],
  p_owner_phones text[],
  p_tenant_phones text[]
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
  --    whatever the report knows, flagged for review, never an UPDATE.
  insert into public.contacts (apartment_number, owner_name, owner_phone, tenant_phone, source, needs_review)
  select btrim(t.a),
         max(nullif(btrim(coalesce(t.onm, '')), '')),
         max(nullif(btrim(coalesce(t.oph, '')), '')),
         max(nullif(btrim(coalesce(t.tph, '')), '')),
         'bllink_sync', true
    from unnest(p_apartments, p_owner_names, p_owner_phones, p_tenant_phones) as t(a, onm, oph, tph)
   where btrim(coalesce(t.a, '')) <> ''
   group by btrim(t.a)
  on conflict (apartment_number) do nothing;
  get diagnostics v_created = row_count;

  -- 2. Fields we simply do not have. No approval: there is nothing to overwrite.
  update public.contacts c set owner_name = i.value
    from public.contact_sync_incoming(p_apartments, p_owner_names, p_owner_phones, p_tenant_phones) i
   where c.apartment_number = i.apartment_number and i.field = 'owner_name'
     and nullif(btrim(coalesce(c.owner_name, '')), '') is null;
  get diagnostics v_n = row_count; v_applied := v_applied + v_n;

  update public.contacts c set owner_phone = i.value
    from public.contact_sync_incoming(p_apartments, p_owner_names, p_owner_phones, p_tenant_phones) i
   where c.apartment_number = i.apartment_number and i.field = 'owner_phone'
     and nullif(btrim(coalesce(c.owner_phone, '')), '') is null;
  get diagnostics v_n = row_count; v_applied := v_applied + v_n;

  update public.contacts c set tenant_phone = i.value
    from public.contact_sync_incoming(p_apartments, p_owner_names, p_owner_phones, p_tenant_phones) i
   where c.apartment_number = i.apartment_number and i.field = 'tenant_phone'
     and nullif(btrim(coalesce(c.tenant_phone, '')), '') is null;
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
             when 'owner_name'  then c.owner_name
             when 'owner_phone' then c.owner_phone
             else c.tenant_phone end);
  get diagnostics v_closed = row_count;

  -- 4. The conflicts. Ours stands; the difference waits for a decision.
  insert into public.contact_sync_suggestions
    (apartment_number, field, current_value, proposed_value, source)
  select i.apartment_number, i.field, cur.v, i.value, 'bllink'
    from public.contact_sync_incoming(p_apartments, p_owner_names, p_owner_phones, p_tenant_phones) i
    join public.contacts c on c.apartment_number = i.apartment_number
    cross join lateral (select case i.field
                                 when 'owner_name'  then c.owner_name
                                 when 'owner_phone' then c.owner_phone
                                 else c.tenant_phone end as v) cur
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
-- Approving writes the value through public.contacts — the SAME column the
-- apartment card writes — so everything downstream follows by itself: the
-- portal roster trigger of 20260929162740 puts an approved owner phone into
-- apartment_owner_phones, and that owner can sign in to the portal at once.
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

    update public.contacts c set tenant_phone = s.proposed_value
      from public.contact_sync_suggestions s
     where s.id = any(p_ids) and s.resolved_at = v_now and s.field = 'tenant_phone'
       and c.apartment_number = s.apartment_number;

    perform set_config('app.write_source', '', true);
  end if;

  return v_n;
end;
$$;

-- migrate:down
drop function if exists public.contact_suggestion_resolve(uuid[], text, uuid);
drop function if exists public.contact_sync_ingest(text[], text[], text[], text[]);
drop function if exists public.contact_sync_incoming(text[], text[], text[], text[]);
drop trigger if exists contacts_field_provenance_aiu on public.contacts;
drop function if exists public.contacts_field_provenance();
drop table if exists public.contact_field_sources;
drop table if exists public.contact_sync_suggestions;
drop function if exists public.contact_value_norm(text, text);
