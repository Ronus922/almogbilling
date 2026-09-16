-- migrate:up

-- Prerequisite #3 of arming the Storage garbage collector with --apply.
--
-- Until now `staged_old` — an attachment uploaded and never sent, older than 24h
-- — would have had its OBJECT removed while its row stayed untouched and still
-- selectable. A compose sheet left open over a weekend could then be submitted
-- and would have sent a file whose bytes no longer exist.
--
-- The row is deliberately NOT deleted: the GC does not touch DB data, and the
-- row is the only remaining record that the file was ever there (original_name,
-- size, who uploaded it, when). It is marked instead, and the two staged
-- lookups — listStagedAttachments / listStagedMessageAttachments — skip marked
-- rows, so a submit is refused with "קובץ מצורף לא נמצא" rather than sending
-- something broken.
--
-- Additive only: nullable, no default, no backfill, no constraint on existing
-- rows. Every row that exists today stays exactly as it is.

alter table public.wa_campaign_attachments
  add column if not exists object_deleted_at timestamptz;

alter table public.wa_message_attachments
  add column if not exists object_deleted_at timestamptz;

comment on column public.wa_campaign_attachments.object_deleted_at is
  'Set by scripts/storage-cleanup.ts when it removed this row''s object from Storage as `staged_old` (unbound and >24h old). The row survives as the record of the upload; the staged lookups skip it so the file can never be attached to a new broadcast. NULL = the object is still there.';

comment on column public.wa_message_attachments.object_deleted_at is
  'Set by scripts/storage-cleanup.ts when it removed this row''s object from Storage as `staged_old` (unbound and >24h old). The row survives as the record of the upload; the staged lookups skip it so the file can never be attached to a new message. NULL = the object is still there.';

-- migrate:down

alter table public.wa_campaign_attachments drop column if exists object_deleted_at;
alter table public.wa_message_attachments drop column if exists object_deleted_at;
