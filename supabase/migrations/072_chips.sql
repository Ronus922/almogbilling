-- 072_chips.sql
-- Access chips (צ'יפי כניסה): chips + chip_events (append-only audit trail)
-- + 'chips' permission seed for managers.
--
-- Model decisions (closed):
--   * chips.contact_id -> contacts(id) ON DELETE RESTRICT — contacts is the
--     apartment registry / single source of truth (071). Non-apartment units
--     (storage/parking/common/staff) are ordinary contacts rows with unit_type,
--     so there is exactly ONE holder path. apartment_number is a display
--     snapshot taken at issuance, never joined at runtime.
--   * chip_number is unique ONLY among active chips (partial unique index) —
--     a deactivated chip's number must be free for re-coding.
--   * No DELETE and no chip_number edits; the only way back is
--     inactive -> active (reactivate). Enforced in the API layer.
--   * holder_name/holder_phone are snapshots at issuance, not runtime joins.
--   * Viewers get NO permission rows (hasPermission is fail-closed);
--     managers get view+edit. admin/super_admin bypass the matrix.
--
-- DOWN: 072_chips.down.sql (separate file).
-- Run: psql "$DIRECT_URL" -f supabase/migrations/072_chips.sql

begin;

create table if not exists public.chips (
  id                    uuid primary key default gen_random_uuid(),
  chip_number           text not null,
  chip_type             text not null default 'physical'
                        check (chip_type in ('physical','app')),
  contact_id            uuid not null references public.contacts(id) on delete restrict,
  apartment_number      text not null,                 -- snapshot at issuance
  status                text not null default 'active'
                        check (status in ('active','inactive')),
  resident_role         text
                        check (resident_role is null or resident_role in ('owner','tenant','operator','staff','other')),
  holder_name           text,                          -- snapshot at issuance
  holder_phone          text,                          -- snapshot at issuance
  issued_at             timestamptz not null default now(),
  issued_by             uuid references public.users(id) on delete set null,
  issued_by_name        text,
  deactivated_at        timestamptz,
  deactivated_by        uuid references public.users(id) on delete set null,
  deactivated_by_name   text,
  deactivation_reason   text
                        check (deactivation_reason is null or deactivation_reason in ('lost','stolen','damaged','returned','moved_out','unknown')),
  controller_synced     boolean not null default false,
  controller_synced_at  timestamptz,
  app_platform          text
                        check (app_platform is null or app_platform in ('ios','android','unknown')),
  app_invite_status     text
                        check (app_invite_status is null or app_invite_status in ('pending','active','expired')),
  app_expires_at        timestamptz,
  issuance_fee          numeric(10,2),
  fee_charged           boolean not null default false,
  limit_override_reason text,
  notes                 text,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now(),
  constraint chips_inactive_requires_reason
    check (status = 'active' or deactivation_reason is not null)
);

create unique index if not exists chips_number_active_uniq
  on public.chips (chip_number) where status = 'active';
create index if not exists chips_contact_idx on public.chips (contact_id);
create index if not exists chips_status_idx  on public.chips (status);
create index if not exists chips_number_idx  on public.chips (chip_number);
create index if not exists chips_type_idx    on public.chips (chip_type);
create index if not exists chips_pending_sync
  on public.chips (id) where status = 'inactive' and controller_synced = false;

drop trigger if exists chips_touch_updated_at on public.chips;
create trigger chips_touch_updated_at before update on public.chips
  for each row execute function public.touch_updated_at();

-- append-only event log — the application layer never UPDATEs or DELETEs rows
create table if not exists public.chip_events (
  id         uuid primary key default gen_random_uuid(),
  chip_id    uuid not null references public.chips(id) on delete cascade,
  event_type text not null
             check (event_type in ('issued','deactivated','reactivated','reassigned','note','controller_synced')),
  old_value  jsonb,
  new_value  jsonb,
  reason     text,
  actor_id   uuid references public.users(id) on delete set null,
  actor_name text,
  created_at timestamptz not null default now()
);
create index if not exists chip_events_chip_idx
  on public.chip_events (chip_id, created_at desc);

-- permission seed: managers get view+edit; viewers/workers get NOTHING
-- (a missing user_permissions row denies — hasPermission is fail-closed).
insert into public.user_permissions (user_id, module, can_view, can_edit)
select u.id, 'chips', true, true
  from public.users u
 where u.role = 'manager'
on conflict (user_id, module) do nothing;

commit;
