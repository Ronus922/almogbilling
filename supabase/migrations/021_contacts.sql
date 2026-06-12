-- 021_contacts.sql
-- Slice 4 Track A — Contacts foundation (DB only; Bllink sync is Track B).
--
-- Adds a first-class `contacts` table (one row per apartment) plus a nullable
-- debtors.contact_id FK so a debtor can be linked to its contact. Additive and
-- idempotent (IF NOT EXISTS / CREATE OR REPLACE) — safe to re-run.
--
-- NOTE on numbering: the spec called this "005", but 005 is already taken by
-- 005_status_management.sql. Next free number in the live sequence is 021.
--
-- Run: psql "$DIRECT_URL" -f supabase/migrations/021_contacts.sql

create table if not exists public.contacts (
  id                              uuid primary key default gen_random_uuid(),
  apartment_number                text not null unique,
  owner_name                      text,
  owner_phone                     text,
  owner_email                     text,
  tenant_name                     text,
  tenant_phone                    text,
  tenant_email                    text,
  resident_type                   text not null default 'owner'
                                    check (resident_type in ('owner', 'tenant', 'operator')),
  operator_id                     uuid,
  owner_is_primary_contact        boolean not null default true,
  tenant_is_primary_contact       boolean not null default false,
  operator_is_primary_contact     boolean not null default false,
  address                         text,
  notes                           text,
  tags                            text[] not null default '{}',
  whatsapp_profile_image_url      text,
  whatsapp_profile_sync_status    text
                                    check (whatsapp_profile_sync_status in
                                      ('pending', 'synced', 'no_avatar', 'unavailable', 'failed')),
  whatsapp_profile_last_synced_at timestamptz,
  whatsapp_profile_sync_error     text,
  last_whatsapp_sent_at           timestamptz,
  last_synced_at                  timestamptz,
  created_at                      timestamptz not null default now(),
  updated_at                      timestamptz not null default now(),
  created_by                      uuid references public.users(id)
);

-- Link debtors → contacts (nullable; a debtor may exist before its contact is created).
alter table public.debtors
  add column if not exists contact_id uuid references public.contacts(id) on delete set null;

create index if not exists contacts_tags_idx        on public.contacts using gin (tags);
create index if not exists contacts_operator_id_idx on public.contacts (operator_id);
create index if not exists debtors_contact_id_idx   on public.debtors (contact_id);

-- updated_at: follow the project convention (public.touch_updated_at() trigger).
drop trigger if exists contacts_touch_updated_at on public.contacts;
create trigger contacts_touch_updated_at
  before update on public.contacts
  for each row execute function public.touch_updated_at();
