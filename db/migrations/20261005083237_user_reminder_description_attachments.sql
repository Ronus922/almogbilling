-- migrate:up
-- Reminders (/user-reminders, public.user_reminders): a free-text description
-- and file attachments (05/10/2026). NOT public.reminders — that table is the
-- notification engine behind RemindersSection.tsx and is untouched.
--
-- description: optional, up to 1000 characters (the panel's "0 / 1000" counter).
--
-- user_reminder_attachments follows fin_documents exactly: the bytes live in
-- the PRIVATE bucket `reminder-attachments` under a `<uuid>.<ext>` key, the
-- readable (Hebrew) name in original_name, and the browser reaches a file only
-- through /api/files/reminder-attachments/<key> (session + user_reminders:view).
-- An upload is STAGED (reminder_id NULL, owned by uploaded_by) and linked when
-- the reminder is saved, so the Storage GC (scripts/storage-cleanup.ts) treats
-- an abandoned upload like any other staged attachment and stamps
-- object_deleted_at when it removes the object.
--
-- Archiving a reminder is a soft delete (is_archived) and keeps its files;
-- only a hard delete (tests) cascades.
--
-- Additive: one nullable column + one new table. No GRANT, no RLS (one service
-- pool, src/lib/db.ts) — the module permission is enforced by the routes.

alter table public.user_reminders
  add column description text;

alter table public.user_reminders
  add constraint user_reminders_description_length
  check (description is null or char_length(description) <= 1000);

comment on column public.user_reminders.description is
  'Optional free text under the title (up to 1000 characters). NULL = none.';

create table public.user_reminder_attachments (
  id                 uuid primary key default gen_random_uuid(),
  reminder_id        uuid references public.user_reminders(id) on delete cascade,
  uploaded_by        uuid references public.users(id) on delete set null,
  bucket             text not null default 'reminder-attachments',
  object_key         text not null unique,
  original_name      text not null,
  mime               text not null,
  size               bigint not null,
  object_deleted_at  timestamptz,
  created_at         timestamptz not null default now(),
  constraint user_reminder_attachments_size_check check (size > 0)
);

create index user_reminder_attachments_reminder_idx
  on public.user_reminder_attachments (reminder_id, created_at);
create index user_reminder_attachments_staged_idx
  on public.user_reminder_attachments (uploaded_by, created_at) where reminder_id is null;

comment on table public.user_reminder_attachments is
  'Files attached to a user_reminders row. reminder_id NULL = uploaded but not yet saved with a reminder (staged by uploaded_by). Same lifecycle as fin_documents.';
comment on column public.user_reminder_attachments.object_key is
  'Storage key in `bucket` (reminder-attachments, private) — <uuid>.<ext>, ASCII only. The readable name is original_name.';
comment on column public.user_reminder_attachments.object_deleted_at is
  'Stamped by the Storage GC when it removed an abandoned staged object. Non-null = the bytes are gone.';

-- migrate:down
drop table if exists public.user_reminder_attachments;
alter table public.user_reminders drop constraint if exists user_reminders_description_length;
alter table public.user_reminders drop column if exists description;
