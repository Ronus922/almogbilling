-- 003_debtor_panel.sql
-- Slice 3 — Debtor panel: statuses + legal status history + comments + debtors extension.
-- Run: docker exec -i supabase-db psql -U postgres -d proj_billing < supabase/migrations/003_debtor_panel.sql

-- ───────────── statuses ─────────────
create table if not exists public.statuses (
  id                   uuid primary key default gen_random_uuid(),
  name                 text not null unique,
  description          text,
  color                text not null default '#e5e7eb',
  is_default           boolean not null default false,
  is_active            boolean not null default true,
  sort_order           integer not null default 0,
  notification_emails  text[],
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now()
);

create index if not exists statuses_sort_idx   on public.statuses (sort_order);
create index if not exists statuses_active_idx on public.statuses (is_active);

drop trigger if exists statuses_touch_updated_at on public.statuses;
create trigger statuses_touch_updated_at
  before update on public.statuses
  for each row execute function public.touch_updated_at();

-- Seed 7 initial statuses (idempotent — skip if already present by name).
insert into public.statuses (name, description, color, is_default, sort_order) values
  ('רגיל',           'סטטוס ברירת מחדל',                         '#f3f4f6', true,  0),
  ('מכתב התראה',     'נשלח מכתב התראה',                            '#fde68a', false, 1),
  ('לטיפול משפטי',   'להעביר לטיפול משפטי',                        '#fecaca', false, 2),
  ('לטיפול רונן',    'שרונן יבדוק איך לטפל בחייב',                  '#bfdbfe', false, 3),
  ('במעקב נעמה',     'נעמה יוצרת קשר עם הלקוח',                    '#ddd6fe', false, 4),
  ('בניהול פתאל',    'בהתערבות אורטל בלבד',                         '#bfdbfe', false, 5),
  ('בהליך משפטי',    'קיימת תביעה משפטית',                          '#fca5a5', false, 6)
on conflict (name) do nothing;

-- ───────────── legal_status_history ─────────────
create table if not exists public.legal_status_history (
  id                uuid primary key default gen_random_uuid(),
  debtor_id         uuid not null references public.debtors(id) on delete cascade,
  apartment_number  text not null,
  old_status_id     uuid references public.statuses(id),
  old_status_name   text,
  new_status_id     uuid references public.statuses(id),
  new_status_name   text,
  changed_at        timestamptz not null default now(),
  changed_by        uuid references public.users(id),
  changed_by_name   text,
  source            text not null default 'MANUAL'
                     check (source in ('MANUAL','IMPORT','AUTO_DEFAULT','SYSTEM_FIX')),
  notes             text
);

create index if not exists legal_status_history_debtor_idx     on public.legal_status_history (debtor_id);
create index if not exists legal_status_history_changed_at_idx on public.legal_status_history (changed_at desc);

-- ───────────── comments ─────────────
create table if not exists public.comments (
  id                uuid primary key default gen_random_uuid(),
  debtor_id         uuid not null references public.debtors(id) on delete cascade,
  apartment_number  text not null,
  content           text not null,
  author_id         uuid references public.users(id),
  author_name       text not null,
  author_email      text,
  created_at        timestamptz not null default now()
);

create index if not exists comments_debtor_idx     on public.comments (debtor_id);
create index if not exists comments_created_at_idx on public.comments (created_at desc);

-- ───────────── debtors extension ─────────────
-- Drop legacy text column (no production data — safe).
drop index if exists public.debtors_legal_status_idx;
alter table public.debtors drop column if exists legal_status;

alter table public.debtors
  add column if not exists legal_status_id              uuid references public.statuses(id),
  add column if not exists legal_status_source          text default 'MANUAL',
  add column if not exists legal_status_lock            boolean not null default false,
  add column if not exists legal_status_updated_at      timestamptz,
  add column if not exists legal_status_updated_by      uuid references public.users(id),
  add column if not exists legal_status_updated_by_name text,
  add column if not exists notes                        text,
  add column if not exists next_action_date             date,
  add column if not exists next_action_description      text,
  add column if not exists last_contact_date            date,
  add column if not exists phones_manual_override       boolean not null default false;

create index if not exists debtors_legal_status_id_idx on public.debtors (legal_status_id);

-- Backfill: every existing debtor gets the default status.
update public.debtors
   set legal_status_id = (select id from public.statuses where is_default = true limit 1)
 where legal_status_id is null;
