// Documents module domain types — generic, foldered, polymorphic document store.
// Single-tenant (no tenant_id). Soft-delete via is_archived. File bytes live in
// Supabase Storage (private bucket `documents`); rows hold only storage_path.
//
// timestamptz columns are returned as strings (the DB layer casts ::text), so
// these are typed `string`, matching the user_reminders / tasks convention.

// ── Folders ──────────────────────────────────────────────────────────────────
export interface DocumentFolder {
  id: string;
  name: string;
  parent_folder_id: string | null;
  created_by: string;
  is_archived: boolean;
  created_at: string;
  updated_at: string;
}

/** Folder row enriched with creator name + live child/document counts (list view). */
export interface DocumentFolderWithMeta extends DocumentFolder {
  created_by_name: string | null;
  subfolder_count: number;
  document_count: number;
}

/** Fields a client may write on a folder. */
export interface DocumentFolderWritableFields {
  name: string;
  parent_folder_id: string | null;
}

// ── Documents ─────────────────────────────────────────────────────────────────
export interface DocumentRow {
  id: string;
  folder_id: string | null;
  file_name: string;
  storage_path: string;
  mime_type: string | null;
  size_bytes: number | null;
  entity_type: string | null;
  entity_id: string | null;
  uploaded_by: string;
  is_archived: boolean;
  created_at: string;
  updated_at: string;
}

/** Document row enriched with uploader name (list view). */
export interface DocumentWithMeta extends DocumentRow {
  uploaded_by_name: string | null;
}

/** A document row plus a freshly-minted signed URL for viewing/downloading. */
export interface DocumentWithSignedUrl extends DocumentWithMeta {
  signed_url: string | null;
}

/** Metadata fields a client may write on a document (the file itself is immutable). */
export interface DocumentWritableFields {
  file_name: string;
  folder_id: string | null;
  entity_type: string | null;
  entity_id: string | null;
}

// ── List filters ──────────────────────────────────────────────────────────────
export interface DocumentFolderListFilters {
  parentFolderId?: string | null; // null → root folders; undefined → all
  includeArchived?: boolean;
}

export interface DocumentListFilters {
  folderId?: string | null; // null → unfiled (folder_id is null); undefined → all
  entityType?: string;
  entityId?: string;
  includeArchived?: boolean;
}
