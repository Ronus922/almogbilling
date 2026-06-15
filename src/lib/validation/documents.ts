// Shared validation + coercion for the Documents module — used by the folder and
// document routes. Pure (no DB, no server-only): safe to import anywhere.
//
// - Partial by design: only keys present in the body appear in the result, so a
//   PATCH never nulls a field the client didn't send.
// - Required fields (folder name) are enforced only in 'create' mode.

import {
  MAX_FOLDER_NAME_LEN,
  MAX_FILE_NAME_LEN,
  MAX_ENTITY_TYPE_LEN,
  MAX_ENTITY_ID_LEN,
} from '@/lib/constants/documents';
import type {
  DocumentFolderWritableFields,
  DocumentWritableFields,
} from '@/lib/types/documents';

export const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type Validation<T> = { ok: true; fields: Partial<T> } | { ok: false; error: string };

function has(body: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(body, key);
}

function strOrNull(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  const t = v.trim();
  return t === '' ? null : t;
}

// ── Folders ──────────────────────────────────────────────────────────────────
export function coerceFolderInput(
  body: Record<string, unknown>,
  mode: 'create' | 'update',
): Validation<DocumentFolderWritableFields> {
  const fields: Partial<DocumentFolderWritableFields> = {};

  // name — required on create; if present on update must be non-empty.
  if (mode === 'create' || has(body, 'name')) {
    const name = strOrNull(body.name);
    if (!name) return { ok: false, error: 'name_required' };
    if (name.length > MAX_FOLDER_NAME_LEN) return { ok: false, error: 'name_too_long' };
    fields.name = name;
  }

  // parent_folder_id — optional, uuid|null. Null means root.
  if (has(body, 'parent_folder_id')) {
    const pid = strOrNull(body.parent_folder_id);
    if (pid !== null && !UUID_RE.test(pid)) {
      return { ok: false, error: 'invalid_parent_folder_id' };
    }
    fields.parent_folder_id = pid;
  }

  return { ok: true, fields };
}

// ── Documents (metadata only — the file is set on upload, never via PATCH) ──────
export function coerceDocumentInput(
  body: Record<string, unknown>,
  mode: 'create' | 'update',
): Validation<DocumentWritableFields> {
  const fields: Partial<DocumentWritableFields> = {};

  // file_name — required on create; if present on update must be non-empty.
  if (mode === 'create' || has(body, 'file_name')) {
    const fn = strOrNull(body.file_name);
    if (!fn) return { ok: false, error: 'file_name_required' };
    if (fn.length > MAX_FILE_NAME_LEN) return { ok: false, error: 'file_name_too_long' };
    fields.file_name = fn;
  }

  if (has(body, 'folder_id')) {
    const fid = strOrNull(body.folder_id);
    if (fid !== null && !UUID_RE.test(fid)) return { ok: false, error: 'invalid_folder_id' };
    fields.folder_id = fid;
  }

  // entity_type / entity_id — polymorphic, open. Both nullable.
  if (has(body, 'entity_type')) {
    const et = strOrNull(body.entity_type);
    if (et && et.length > MAX_ENTITY_TYPE_LEN) return { ok: false, error: 'entity_type_too_long' };
    fields.entity_type = et;
  }
  if (has(body, 'entity_id')) {
    const eid = strOrNull(body.entity_id);
    if (eid && eid.length > MAX_ENTITY_ID_LEN) return { ok: false, error: 'entity_id_too_long' };
    fields.entity_id = eid;
  }

  return { ok: true, fields };
}
