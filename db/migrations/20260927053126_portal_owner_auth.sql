-- migrate:up
-- Owners portal ("פורטל בעלי דירות") — the WhatsApp-OTP login layer of /portal.
--
-- Decisions (Decisions Log 27/09/2026):
--   • OWNERS ONLY. A tenant's phone grants nothing: the roster below is built
--     from owner phones, so a tenant number simply is not in it.
--   • An apartment may have SEVERAL owners, each with their own phone, and one
--     phone may own SEVERAL apartments — hence a junction table keyed on
--     (apartment_number, phone_e164) rather than a column on contacts.
--   • Access is automatic: a phone on the roster with is_active = true gets in.
--     No manual approval step.
--   • This layer is ISOLATED from the staff login: its own cookie
--     (portal_session), its own sessions table, its own guard. The staff cookie
--     opens nothing under /portal and vice versa.
--   • Phones are stored in E.164 (+972…) — the one canonical form for the
--     roster, the codes, the sessions, the lockouts and the log.
--   • The code itself is NEVER stored or logged in the clear: only its bcrypt
--     hash (portal_otp_codes.code_hash), exactly like public.users.password_hash.
--   • Retention: the login log is kept for a YEAR. No automatic deletion is
--     wired in this slice — recorded here as the intent (see PROJECT_CONTEXT).
--
-- Additive only: five new tables, nothing existing changes. Like every table
-- here: no GRANT, no RLS (one service pool, see src/lib/db.ts).

-- ── The roster: which phone owns which apartment ────────────────────────────
create table public.apartment_owner_phones (
  id                uuid primary key default gen_random_uuid(),
  apartment_number  text not null
                      references public.contacts(apartment_number)
                      on update cascade on delete restrict,
  owner_name        text,
  phone_e164        text not null,
  is_active         boolean not null default true,
  created_at        timestamptz not null default now(),
  created_by        uuid references public.users(id) on delete set null,
  constraint apartment_owner_phones_apartment_phone_key unique (apartment_number, phone_e164),
  constraint apartment_owner_phones_phone_e164_check check (phone_e164 ~ '^\+9725[0-9]{8}$')
);

create index apartment_owner_phones_phone_e164_idx on public.apartment_owner_phones (phone_e164);

comment on table public.apartment_owner_phones is
  'Owners-portal roster: which phone (E.164) may sign in on behalf of which apartment. Several owners per apartment and several apartments per phone are both normal. is_active = false revokes access without losing the record. Israeli MOBILE only — the code is delivered over WhatsApp.';
comment on column public.apartment_owner_phones.owner_name is
  'Display name for the admin log ("בעלים" column). Nullable: some rows come from contact_people entries that have a phone but no name.';

-- ── One-time codes ──────────────────────────────────────────────────────────
create table public.portal_otp_codes (
  id           uuid primary key default gen_random_uuid(),
  phone_e164   text not null,
  code_hash    text not null,
  expires_at   timestamptz not null,
  attempts     integer not null default 0,
  consumed_at  timestamptz,
  ip           text,
  created_at   timestamptz not null default now(),
  constraint portal_otp_codes_attempts_check check (attempts >= 0)
);

create index portal_otp_codes_phone_created_idx on public.portal_otp_codes (phone_e164, created_at desc);

comment on table public.portal_otp_codes is
  'WhatsApp one-time codes for the owners portal. code_hash is bcrypt of the 6 digits (never the digits themselves, here or in the log). attempts counts wrong guesses against THIS code; consumed_at marks a successful login.';

-- ── Portal sessions (separate from public.sessions) ─────────────────────────
create table public.portal_sessions (
  id          uuid primary key default gen_random_uuid(),
  token_hash  text not null unique,
  phone_e164  text not null,
  created_at  timestamptz not null default now(),
  expires_at  timestamptz not null,
  revoked_at  timestamptz,
  ip          text,
  user_agent  text
);

create index portal_sessions_phone_idx on public.portal_sessions (phone_e164);

comment on table public.portal_sessions is
  'Sessions of the owners portal — deliberately NOT public.sessions: a portal session has no users row, and the staff cookie must never open /portal. token_hash is sha256 of the raw token that lives only in the portal_session cookie (same contract as public.sessions.id).';

-- ── Escalating lockouts ─────────────────────────────────────────────────────
create table public.portal_lockouts (
  id            uuid primary key default gen_random_uuid(),
  phone_e164    text not null,
  locked_until  timestamptz not null,
  tier          smallint not null,
  reason        text not null,
  created_at    timestamptz not null default now(),
  released_by   uuid references public.users(id) on delete set null,
  released_at   timestamptz,
  constraint portal_lockouts_tier_check check (tier between 1 and 3),
  constraint portal_lockouts_reason_check check (reason in ('too_many_invalid_codes', 'too_many_code_requests'))
);

create index portal_lockouts_phone_created_idx on public.portal_lockouts (phone_e164, created_at desc);

comment on table public.portal_lockouts is
  'Escalating temporary lockouts of a phone: tier 1 = 30 minutes, 2 = 2 hours, 3 = 24 hours. The tier rises when a lockout repeats within 24h. released_by / released_at record a manual "שחרר חסימה" from the apartment card.';

-- ── The login log ───────────────────────────────────────────────────────────
create table public.portal_login_events (
  id                 uuid primary key default gen_random_uuid(),
  phone_e164         text not null,
  apartment_numbers  text[] not null default '{}',
  event_type         text not null,
  ip                 text,
  user_agent         text,
  details            jsonb,
  created_at         timestamptz not null default now(),
  constraint portal_login_events_event_type_check check (event_type in (
    'code_requested', 'code_sent', 'send_failed', 'code_invalid', 'code_expired',
    'login_success', 'phone_not_found', 'phone_inactive', 'locked_out',
    'unlocked_manually', 'session_revoked'
  ))
);

create index portal_login_events_phone_idx on public.portal_login_events (phone_e164);
create index portal_login_events_created_at_idx on public.portal_login_events (created_at desc);

comment on table public.portal_login_events is
  'Every portal login attempt, including attempts from a phone that is not on the roster (apartment_numbers stays empty — the admin screen shows "—"). Kept for a year; no automatic purge in this slice. details NEVER contains the code itself.';
comment on column public.portal_login_events.apartment_numbers is
  'Every apartment the phone owns at the time of the event. Empty when the phone is unknown. A plain text[] snapshot, not an FK: the log must survive a roster change.';

-- ── Backfill: the owner phones already in the system ────────────────────────
-- Two sources, both already the source of truth for "who owns this apartment":
--   1. contacts.owner_phone       — the first owner of the apartment
--   2. contact_people role='owner' — the additional owners (310 rows on
--      27/09/2026, across 184 apartments that hold more than one owner phone)
-- Taking only (1) would have denied the portal to ~278 registered owner phones,
-- contradicting the "several owners per apartment" decision — so both go in.
-- ISRAELI MOBILE ONLY ('^05\d{8}$' → '+9725…'): the code travels over WhatsApp,
-- so a landline row would be a roster entry that can never sign in. Deduplicated
-- by the unique key via `on conflict do nothing`; an empty name stays NULL.
insert into public.apartment_owner_phones (apartment_number, owner_name, phone_e164)
select apartment_number, owner_name, phone_e164
from (
  select
    c.apartment_number,
    nullif(btrim(c.owner_name), '')              as owner_name,
    '+972' || substring(c.owner_phone from 2)    as phone_e164,
    1                                            as src
  from public.contacts c
  where c.owner_phone ~ '^05[0-9]{8}$'
  union all
  select
    c.apartment_number,
    nullif(btrim(p.name), '')                    as owner_name,
    '+972' || substring(p.phone from 2)          as phone_e164,
    2                                            as src
  from public.contact_people p
  join public.contacts c on c.id = p.contact_id
  where p.role = 'owner' and p.phone ~ '^05[0-9]{8}$'
) s
-- A phone listed both as the primary owner and as an extra: keep the primary
-- row (src 1), which is the one that carries contacts.owner_name.
order by apartment_number, phone_e164, src
on conflict (apartment_number, phone_e164) do nothing;

-- migrate:down
drop table if exists public.portal_login_events;
drop table if exists public.portal_lockouts;
drop table if exists public.portal_sessions;
drop table if exists public.portal_otp_codes;
drop table if exists public.apartment_owner_phones;
