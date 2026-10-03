-- migrate:up
-- Owners portal: an owner reports a fault in a common area (decision 03/10/2026).
-- The report is an ordinary row of public.issues — same table, same panel, same
-- handlers — marked by `source` and carrying a SNAPSHOT of who reported it.
--
-- Additive only. The frozen Base44 columns (location_type, location_text,
-- assigned_to_user_id, supplier_id — Phase B drops them) are not touched: the
-- resident's free-text location goes to the two new reporter_* text columns.
--
--   source              'staff' for every existing and every staff-made row
--                       (the default), 'portal' for a resident's report.
--   reporter_contact_id the roster row (apartment_owner_phones) of the phone +
--                       apartment that signed in. SET NULL on delete: the
--                       snapshot below is the history, the link is a pointer.
--   reporter_name / reporter_phone (E.164) / reporter_apartment
--                       copied from the session at report time, so a later
--                       change to the contacts never rewrites who reported.
--   reporter_location / reporter_area
--                       "מיקום" and "קומה / אזור" exactly as the resident typed.
--   ticket_number       the "מספר קריאה" the resident sees on the confirmation
--                       screen (an issue id is a uuid). Portal rows only; from
--                       its own sequence, starting at 1001.
alter table public.issues
  add column source text not null default 'staff',
  add column reporter_contact_id uuid,
  add column reporter_name text,
  add column reporter_phone text,
  add column reporter_apartment text,
  add column reporter_location text,
  add column reporter_area text,
  add column ticket_number integer;

alter table public.issues
  add constraint issues_source_check check (source in ('staff', 'portal')),
  add constraint issues_reporter_contact_id_fkey foreign key (reporter_contact_id)
    references public.apartment_owner_phones (id) on delete set null,
  add constraint issues_reporter_phone_e164_check check (
    reporter_phone is null or reporter_phone ~ '^\+[1-9][0-9]{6,14}$'
  ),
  -- A portal row always knows who, where and its call number (the contact link
  -- may be nulled later, the snapshot never is).
  add constraint issues_portal_reporter_check check (
    source <> 'portal' or (
      reporter_phone is not null
      and reporter_apartment is not null
      and reporter_location is not null
      and ticket_number is not null
    )
  ),
  add constraint issues_ticket_number_key unique (ticket_number);

create sequence public.issues_ticket_number_seq as integer start with 1001
  owned by public.issues.ticket_number;

comment on column public.issues.source is
  'Who opened the issue: staff (the issues screen) or portal (an owner, through /portal/report).';
comment on column public.issues.reporter_contact_id is
  'Portal reports: the apartment_owner_phones row (phone + apartment) that signed in. Pointer only — the reporter_* snapshot is the record.';
comment on column public.issues.reporter_phone is
  'Portal reports: the reporter''s phone at report time, E.164, from the portal session. Served only to staff with contacts:view.';
comment on column public.issues.reporter_apartment is
  'Portal reports: the reporter''s apartment at report time (the lowest-numbered apartment of the phone).';
comment on column public.issues.reporter_location is
  'Portal reports: "מיקום" as the resident typed it.';
comment on column public.issues.reporter_area is
  'Portal reports: "קומה / אזור" as the resident typed it (optional).';
comment on column public.issues.ticket_number is
  'Portal reports: the call number shown to the resident (issues_ticket_number_seq, from 1001).';

-- migrate:down
-- Drops only what the up added. ticket_number takes its OWNED sequence with it.
alter table public.issues
  drop constraint if exists issues_ticket_number_key,
  drop constraint if exists issues_portal_reporter_check,
  drop constraint if exists issues_reporter_phone_e164_check,
  drop constraint if exists issues_reporter_contact_id_fkey,
  drop constraint if exists issues_source_check;

alter table public.issues
  drop column if exists ticket_number,
  drop column if exists reporter_area,
  drop column if exists reporter_location,
  drop column if exists reporter_apartment,
  drop column if exists reporter_phone,
  drop column if exists reporter_name,
  drop column if exists reporter_contact_id,
  drop column if exists source;
