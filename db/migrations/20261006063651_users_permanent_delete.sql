-- migrate:up
-- Permanent deletion of a staff user (06/10/2026): the account row goes, the
-- content the user wrote stays — with their name next to it.
--
-- Most content tables already keep the author's name as text beside the id
-- (comments.author_name, issues.created_by_name, task_comments.author_name,
-- internal_messages.sender_name, …). These six still showed the name through
-- a join on public.users at read time, so a deleted user would have left
-- them blank. Each gets a text snapshot, backfilled from users here, written
-- by the insert from now on, and filled again by the delete endpoint for
-- anything still null — the read side prefers the live name while the user
-- exists (`coalesce(u.full_name, <snapshot>)`) and falls back to the
-- snapshot once they are gone.
--
-- Five columns that reference users had no ON DELETE action AND were NOT
-- NULL, so a user row could never be deleted at all (Postgres' NO ACTION
-- refuses the delete). The FKs themselves are untouched — only the NOT NULL
-- goes, so the delete endpoint can set them to NULL like every other
-- reference. Nothing else writes NULL there: every insert still passes the
-- acting user.
--
-- Additive: columns added or loosened, no FK changed, no row removed.

alter table public.chat_messages    add column sent_by_name    text;
alter table public.wa_campaigns     add column created_by_name text;
alter table public.documents        add column uploaded_by_name text;
alter table public.document_folders add column created_by_name text;
alter table public.user_reminders   add column created_by_name text;
alter table public.audit_log        add column actor_name      text;

comment on column public.chat_messages.sent_by_name is
  'Snapshot of the sending staff user''s name (full_name, else username). Shown once the user is deleted; the live name wins while they exist.';
comment on column public.wa_campaigns.created_by_name is
  'Snapshot of the creating user''s name — survives the user''s deletion.';
comment on column public.documents.uploaded_by_name is
  'Snapshot of the uploading user''s name — survives the user''s deletion.';
comment on column public.document_folders.created_by_name is
  'Snapshot of the creating user''s name — survives the user''s deletion.';
comment on column public.user_reminders.created_by_name is
  'Snapshot of the creating user''s name — survives the user''s deletion (the assignee sees who wrote the reminder).';
comment on column public.audit_log.actor_name is
  'Snapshot of the acting user''s name — survives the user''s deletion (actor_user_id goes NULL then).';

update public.chat_messages m set sent_by_name = coalesce(u.full_name, u.username)
  from public.users u where u.id = m.sent_by and m.sent_by_name is null;
update public.wa_campaigns w set created_by_name = coalesce(u.full_name, u.username)
  from public.users u where u.id = w.created_by and w.created_by_name is null;
update public.documents d set uploaded_by_name = coalesce(u.full_name, u.username)
  from public.users u where u.id = d.uploaded_by and d.uploaded_by_name is null;
update public.document_folders f set created_by_name = coalesce(u.full_name, u.username)
  from public.users u where u.id = f.created_by and f.created_by_name is null;
update public.user_reminders r set created_by_name = coalesce(u.full_name, u.username)
  from public.users u where u.id = r.created_by and r.created_by_name is null;
update public.audit_log a set actor_name = coalesce(u.full_name, u.username)
  from public.users u where u.id = a.actor_user_id and a.actor_name is null;

alter table public.document_folders   alter column created_by  drop not null;
alter table public.documents          alter column uploaded_by drop not null;
alter table public.reminder_categories alter column created_by drop not null;
alter table public.user_invites       alter column invited_by  drop not null;
alter table public.user_reminders     alter column created_by  drop not null;

-- migrate:down
-- Restoring NOT NULL fails if a user has been deleted since (its references
-- are NULL by then) — that is the point of the change, not a defect of the
-- rollback: there is no user to put back.
alter table public.user_reminders     alter column created_by  set not null;
alter table public.user_invites       alter column invited_by  set not null;
alter table public.reminder_categories alter column created_by set not null;
alter table public.documents          alter column uploaded_by set not null;
alter table public.document_folders   alter column created_by  set not null;

alter table public.audit_log        drop column actor_name;
alter table public.user_reminders   drop column created_by_name;
alter table public.document_folders drop column created_by_name;
alter table public.documents        drop column uploaded_by_name;
alter table public.wa_campaigns     drop column created_by_name;
alter table public.chat_messages    drop column sent_by_name;
