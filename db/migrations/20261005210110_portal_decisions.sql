-- migrate:up
-- Decisions & protocols of the house committee (05/10/2026): one PDF per row,
-- uploaded from the CRM (/decisions) and read by the owners portal's
-- "החלטות" tab. Residents never write here — the portal is read-only.
--
-- One flat list, newest first, grouped by the YEAR of decided_at on screen.
-- There is no building_id: this schema serves ONE building (no table carries
-- one), and no topic/category column — the category chips of the reference
-- were dropped by decision, so the row has nothing to group by but its type.
--
-- The bytes live in the PRIVATE bucket `portal-decisions` under a `<uuid>.pdf`
-- key (ASCII; buildObjectKey) and the readable Hebrew name only in
-- original_filename — exactly like fin_documents / user_reminder_attachments.
-- There is no staged state: the row and the object are created by ONE request
-- (POST /api/decisions), and a failed insert removes the object it uploaded,
-- so object_key is always claimed by a live row.
--
-- Two readers, one table:
--   • the CRM lists EVERY row (published or not) — portal_decisions:view;
--   • the portal lists only `published` and streams the file only for a
--     published row, through /api/portal/decisions/[id]/file. Unpublishing is
--     immediate and closes the file path too.
--
-- Additive: one new table. No GRANT, no RLS (one service pool, src/lib/db.ts)
-- — the module permission is enforced by the routes.

create table public.portal_decisions (
  id                uuid primary key default gen_random_uuid(),
  title             text not null,
  summary           text,
  doc_type          text not null check (doc_type in ('decision', 'protocol')),
  decision_number   text,
  decided_at        date not null,
  bucket            text not null default 'portal-decisions',
  object_key        text not null unique,
  original_filename text not null,
  file_size         bigint not null,
  mime_type         text not null,
  published         boolean not null default true,
  created_by        uuid references public.users(id) on delete set null,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  constraint portal_decisions_title_length check (char_length(title) between 1 and 200),
  constraint portal_decisions_summary_length check (summary is null or char_length(summary) <= 2000),
  constraint portal_decisions_number_length check (decision_number is null or char_length(decision_number) between 1 and 40),
  constraint portal_decisions_file_size_check check (file_size > 0)
);

-- The portal's ONE query: published rows, newest decision first.
create index portal_decisions_published_idx
  on public.portal_decisions (published, decided_at desc);

comment on table public.portal_decisions is
  'House-committee decisions and assembly protocols, one PDF each. Managed in the CRM (/decisions); the owners portal reads only published rows.';
comment on column public.portal_decisions.doc_type is
  'decision = החלטה (may carry decision_number) · protocol = פרוטוקול (never numbered on screen).';
comment on column public.portal_decisions.decision_number is
  'Free-form label of a decision, e.g. "14/2026". NULL for a protocol and for an unnumbered decision.';
comment on column public.portal_decisions.object_key is
  'Storage key in `bucket` (portal-decisions, private) — <uuid>.pdf, ASCII only. The readable name is original_filename.';
comment on column public.portal_decisions.published is
  'false = hidden from the portal entirely, list AND file path. The CRM still lists it.';

-- migrate:down
drop table if exists public.portal_decisions;
