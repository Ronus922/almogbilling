-- 031_documents.sql
-- Documents module — generic, foldered, polymorphic document store. Backend only
-- (UI ships in a later design session).
--
-- ADDITIVE ONLY. Creates two new tables + their indexes + updated_at triggers.
-- Idempotent (IF NOT EXISTS / DROP TRIGGER IF EXISTS). No existing table is
-- touched, no data migration, no drops.
--
-- ── Relationship to public.supplier_documents (migration 011) ────────────────
-- supplier_documents is SUPPLIER-SCOPED (FK supplier_id, on delete cascade) and
-- stays as-is for the suppliers panel. THIS module is the GENERIC document store:
-- nested folders (document_folders.parent_folder_id) + a polymorphic link
-- (entity_type / entity_id, open — no rigid CHECK) so a document can attach to a
-- debtor / supplier / task / … or stand unfiled. The two coexist; this migration
-- does not migrate supplier_documents into it.
--
-- ── Storage ──────────────────────────────────────────────────────────────────
-- File bytes live in the self-hosted Supabase Storage (private bucket
-- `documents`), exactly like supplierStorage. The DB row keeps only the object
-- PATH in storage_path; the API issues short-lived signed URLs for viewing, so
-- files stay behind the documents:view permission. Requires a valid
-- SUPABASE_SERVICE_ROLE_KEY — if missing, uploads fail with a clear error
-- (storage helper throws 'supabase_storage_not_configured'); the schema is
-- unaffected.
--
-- ── Soft-delete ──────────────────────────────────────────────────────────────
-- is_archived is the soft-delete flag (consistent with tasks / user_reminders).
-- Rows are retained; DELETE endpoints set is_archived=true.
--
-- ── FK / on-delete rationale ─────────────────────────────────────────────────
--   • created_by / uploaded_by → users(id), NOT NULL, NO on-delete clause
--     (NO ACTION). Mirrors user_reminders: users are deactivated, never
--     hard-deleted, so a creator cannot vanish while their rows exist.
--   • parent_folder_id → document_folders(id) ON DELETE SET NULL — a manual
--     hard-delete of a folder re-parents its subfolders to root rather than
--     cascading them away (soft-delete is the normal path; this only guards
--     accidental hard deletes).
--   • documents.folder_id → document_folders(id) ON DELETE SET NULL — likewise,
--     a hard-deleted folder floats its documents to "unfiled" rather than
--     destroying document rows.
--   • entity_id is text (not uuid) and un-FK'd — polymorphic across entities
--     whose ids may differ; both entity_type/entity_id nullable (unfiled doc).
--
-- Run: psql "$DIRECT_URL" -f supabase/migrations/031_documents.sql

begin;

-- ── Folders (nestable) ───────────────────────────────────────────────────────
create table if not exists public.document_folders (
  id                uuid primary key default gen_random_uuid(),
  name              text not null,
  parent_folder_id  uuid references public.document_folders(id) on delete set null,
  created_by        uuid not null references public.users(id),
  is_archived       boolean not null default false,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);

create index if not exists document_folders_parent_idx
  on public.document_folders (parent_folder_id);
create index if not exists document_folders_created_by_idx
  on public.document_folders (created_by);

drop trigger if exists document_folders_touch_updated_at on public.document_folders;
create trigger document_folders_touch_updated_at
  before update on public.document_folders
  for each row execute function public.touch_updated_at();

-- ── Documents ────────────────────────────────────────────────────────────────
create table if not exists public.documents (
  id            uuid primary key default gen_random_uuid(),
  folder_id     uuid references public.document_folders(id) on delete set null,
  file_name     text not null,
  storage_path  text not null,
  mime_type     text,
  size_bytes    bigint,
  -- Polymorphic link. Open (no rigid CHECK), text id (not uuid) so it can
  -- reference entities whose id may not be uuid. Both nullable — a document can
  -- be unfiled (no entity).
  entity_type   text,
  entity_id     text,
  uploaded_by   uuid not null references public.users(id),
  is_archived   boolean not null default false,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

create index if not exists documents_folder_idx      on public.documents (folder_id);
create index if not exists documents_entity_idx       on public.documents (entity_type, entity_id);
create index if not exists documents_uploaded_by_idx  on public.documents (uploaded_by);

drop trigger if exists documents_touch_updated_at on public.documents;
create trigger documents_touch_updated_at
  before update on public.documents
  for each row execute function public.touch_updated_at();

commit;
