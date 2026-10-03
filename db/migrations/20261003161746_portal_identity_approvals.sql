-- migrate:up
-- Confirmed identity for a portal phone (approved 03/10/2026, "אישור זהות").
--
-- The containment of 03/10/2026 blocks a phone whose apartments carry
-- different names: nothing shows the two names are one person. Some are —
-- a company and the person who runs it, a spelling, a parent paying for a
-- child's flat. A person with portal_manage can now say so: "זה אדם אחד",
-- with the name the portal greets them by and, per apartment, how they are
-- connected to it. From that moment the phone is not blocked.
--
-- The approval covers the NAMES the phone carried when it was given (stored,
-- whitespace-normalised). A name added to the phone afterwards is not covered:
-- the phone is blocked again until someone approves again. Revoking an
-- approval blocks it again at once. Nothing here touches the roster — the
-- decision is read on every portal request (lib/db/portal/identity.ts).
--
-- A request can also wait: someone without portal_manage who confirms "same
-- person" on the apartment card leaves a PENDING request on the blocked-phones
-- screen, and the phone stays blocked until it is approved there.
--
-- "Different person" on the apartment card leaves an entry flag — the phone is
-- blocked by the different names anyway, and the flag tells the blocked-phones
-- screen this is a suspected typing mistake, not a spelling to unify.
--
-- Additive: three new tables. Every decision is also an audit_log row,
-- written by the code that makes it.

create table public.portal_identity_approvals (
  id             uuid primary key default gen_random_uuid(),
  phone_e164     text not null,
  status         text not null,
  display_name   text,
  names          text[] not null default '{}',
  request_source text not null,
  requested_by   uuid references public.users(id) on delete set null,
  requested_at   timestamptz not null default now(),
  decided_by     uuid references public.users(id) on delete set null,
  decided_at     timestamptz,
  ended_by       uuid references public.users(id) on delete set null,
  ended_at       timestamptz,
  constraint portal_identity_approvals_phone_check
    check (phone_e164 ~ '^\+[1-9][0-9]{6,14}$'),
  constraint portal_identity_approvals_status_check
    check (status in ('pending', 'approved', 'superseded', 'revoked', 'rejected')),
  constraint portal_identity_approvals_source_check
    check (request_source in ('blocked_screen', 'entry_warning')),
  constraint portal_identity_approvals_approved_shape_check
    check (status not in ('approved', 'superseded', 'revoked')
           or (nullif(btrim(coalesce(display_name, '')), '') is not null and decided_at is not null)),
  constraint portal_identity_approvals_ended_shape_check
    check ((status in ('superseded', 'revoked', 'rejected')) = (ended_at is not null)),
  -- A record with no name is not approved away: the name is filled in on the
  -- card. So an approval never covers the empty name.
  constraint portal_identity_approvals_names_check
    check (not ('' = any(names)))
);

comment on table public.portal_identity_approvals is
  'A person with portal_manage confirmed that one phone, carrying several names, is ONE person. status: pending (asked from the apartment card, waiting) · approved (in force) · superseded (replaced by a newer approval) · revoked · rejected. names = the whitespace-normalised names the approval covers; a name outside it blocks the phone again.';

create unique index portal_identity_approvals_one_approved
  on public.portal_identity_approvals (phone_e164) where status = 'approved';
create unique index portal_identity_approvals_one_pending
  on public.portal_identity_approvals (phone_e164) where status = 'pending';

create table public.portal_identity_apartments (
  approval_id      uuid not null references public.portal_identity_approvals(id) on delete cascade,
  apartment_number text not null,
  relation         text not null,
  primary key (approval_id, apartment_number),
  constraint portal_identity_apartments_relation_check
    check (relation in ('personal', 'company_authorized', 'family'))
);

comment on table public.portal_identity_apartments is
  'Per apartment of an approved identity: how the person is connected to it — personal (their own), company_authorized (authorised for a company), family (a relative).';

create table public.portal_phone_entry_flags (
  id               uuid primary key default gen_random_uuid(),
  phone_e164       text not null,
  apartment_number text not null,
  entered_name     text,
  other_apartments text[] not null default '{}',
  flagged_by       uuid references public.users(id) on delete set null,
  flagged_at       timestamptz not null default now(),
  cleared_by       uuid references public.users(id) on delete set null,
  cleared_at       timestamptz
);

comment on table public.portal_phone_entry_flags is
  'Someone typed a phone on an apartment card that another apartment already carries under another name, and answered "a different person": a suspected typing mistake. The phone is blocked by the different names; the flag is what the blocked-phones screen shows about it.';

create index portal_phone_entry_flags_open
  on public.portal_phone_entry_flags (phone_e164) where cleared_at is null;

-- migrate:down
drop table if exists public.portal_phone_entry_flags;
drop table if exists public.portal_identity_apartments;
drop table if exists public.portal_identity_approvals;
