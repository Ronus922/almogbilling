-- migrate:up
-- "סריקת כניסה" (visitor ID scan, 08/11/2026): a seventh role, `guard`, that
-- sees one screen only, and the table of scanned visitors.
--
-- Additive in effect, three parts:
--   1. users_role_check also accepts 'guard'. user_invites_role_check is left
--      alone on purpose: a guard is never invited by e-mail (the admin types a
--      username and a password), so an invite for one must stay impossible.
--   2. users.email loses NOT NULL. A guard needs no mailbox. Every existing row
--      keeps its address; the unique constraint and the unique lower(email)
--      index both ignore NULLs, so two guards without a mailbox never collide.
--   3. visitor_scans — one row per scanned document. The image lives in the
--      private Storage bucket `visitor-ids` (key = <uuid>.jpg, never a URL);
--      only the key and the original name are stored here. Kept forever (no TTL).
--      scanned_by_name is a snapshot: the author stays readable after the user
--      is deleted for good (FK is SET NULL, like every other author column).

alter table public.users drop constraint users_role_check;
alter table public.users add constraint users_role_check
  check (role = any (array['super_admin', 'admin', 'manager', 'viewer', 'cleaner', 'maintenance', 'guard']));

alter table public.users alter column email drop not null;

create table public.visitor_scans (
  id                  uuid primary key default gen_random_uuid(),
  document_type       text not null
                        constraint visitor_scans_document_type_check
                        check (document_type in ('id_card', 'driver_license', 'passport')),
  document_number     text not null,
  first_name          text not null,
  last_name           text not null,
  date_of_birth       date,
  nationality         text,
  phone               text,
  room_number         text,
  chip_number         text,
  notes               text,
  image_object_key    text not null,
  image_original_name text,
  scanned_by          uuid references public.users (id) on delete set null,
  scanned_by_name     text,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);

create index visitor_scans_created_at_idx on public.visitor_scans (created_at desc);
create index visitor_scans_phone_idx on public.visitor_scans (phone);
create index visitor_scans_name_idx on public.visitor_scans (lower(first_name || ' ' || last_name));
create index visitor_scans_document_number_idx on public.visitor_scans (document_number);
-- Every open of a photo (/api/files/visitor-ids/<key>) looks the row up by this key.
create unique index visitor_scans_image_object_key_idx on public.visitor_scans (image_object_key);

comment on table public.visitor_scans is
  'Scanned visitor documents (id card / driver licence / passport). The image is in the private bucket visitor-ids, served only through /api/files. Kept forever.';

-- migrate:down
-- Refuses to run while anything depends on the new shape: dropping the CHECK
-- back would fail on a guard row, NOT NULL on an address-less user, and dropping
-- the table would destroy the scans (and orphan their photos in Storage). Each
-- case needs a human decision (delete or re-role the guards, delete the scans on
-- purpose), not a silent data loss in a rollback.
do $$
begin
  if exists (select 1 from public.visitor_scans) then
    raise exception 'down refused: visitor_scans has rows — delete them (and their photos in the visitor-ids bucket) on purpose first';
  end if;
  if exists (select 1 from public.users where role = 'guard') then
    raise exception 'down refused: users with role guard exist — delete or re-role them first';
  end if;
  if exists (select 1 from public.users where email is null) then
    raise exception 'down refused: users without an e-mail exist — give them one first';
  end if;
end
$$;

drop table if exists public.visitor_scans;

alter table public.users alter column email set not null;

alter table public.users drop constraint users_role_check;
alter table public.users add constraint users_role_check
  check (role = any (array['super_admin', 'admin', 'manager', 'viewer', 'cleaner', 'maintenance']));
