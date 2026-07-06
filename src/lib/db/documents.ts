import 'server-only';
import { query, queryOne } from '@/lib/db';
import type {
  DocumentFolder,
  DocumentFolderWithMeta,
  DocumentFolderWritableFields,
  DocumentFolderListFilters,
  DocumentRow,
  DocumentWithMeta,
  DocumentWritableFields,
  DocumentListFilters,
} from '@/lib/types/documents';

// timestamptz columns are cast to text so they cross the RSC/JSON boundary as
// strings (matching the declared `string` types) — pg otherwise returns Date
// objects. Mirrors the tasks / user_reminders convention.
const FOLDER_COLUMNS = `
  id, name, parent_folder_id, created_by, is_archived,
  created_at::text as created_at, updated_at::text as updated_at
`;

const DOC_COLUMNS = `
  id, folder_id, file_name, storage_path, mime_type, size_bytes,
  entity_type, entity_id, uploaded_by, is_archived,
  created_at::text as created_at, updated_at::text as updated_at
`;

function prefixed(columns: string, alias: string): string {
  return columns
    .split(',')
    .map((c) => {
      const t = c.trim();
      // Re-alias the casted timestamp columns onto the table alias.
      if (t.startsWith('created_at::text')) return `${alias}.created_at::text as created_at`;
      if (t.startsWith('updated_at::text')) return `${alias}.updated_at::text as updated_at`;
      return `${alias}.${t}`;
    })
    .join(', ');
}

// ── Folders ──────────────────────────────────────────────────────────────────
export async function listDocumentFolders(
  filters: DocumentFolderListFilters,
): Promise<DocumentFolderWithMeta[]> {
  const where: string[] = [];
  const vals: unknown[] = [];

  if (!filters.includeArchived) where.push('f.is_archived = false');

  if (filters.parentFolderId === null) {
    where.push('f.parent_folder_id is null');
  } else if (filters.parentFolderId !== undefined) {
    vals.push(filters.parentFolderId);
    where.push(`f.parent_folder_id = $${vals.length}`);
  }

  const whereSql = where.length ? `where ${where.join(' and ')}` : '';
  const r = await query<DocumentFolderWithMeta>(
    `select ${prefixed(FOLDER_COLUMNS, 'f')},
            uc.full_name as created_by_name,
            (select count(*)::int from public.document_folders s
               where s.parent_folder_id = f.id and s.is_archived = false) as subfolder_count,
            (select count(*)::int from public.documents d
               where d.folder_id = f.id and d.is_archived = false) as document_count
       from public.document_folders f
       left join public.users uc on uc.id = f.created_by
       ${whereSql}
       order by f.name asc`,
    vals,
  );
  return r.rows;
}

export async function getDocumentFolderById(id: string): Promise<DocumentFolderWithMeta | null> {
  return queryOne<DocumentFolderWithMeta>(
    `select ${prefixed(FOLDER_COLUMNS, 'f')},
            uc.full_name as created_by_name,
            (select count(*)::int from public.document_folders s
               where s.parent_folder_id = f.id and s.is_archived = false) as subfolder_count,
            (select count(*)::int from public.documents d
               where d.folder_id = f.id and d.is_archived = false) as document_count
       from public.document_folders f
       left join public.users uc on uc.id = f.created_by
      where f.id = $1
      limit 1`,
    [id],
  );
}

/** Lightweight existence + active check (used to validate parent/folder refs). */
export async function folderExistsActive(id: string): Promise<boolean> {
  const row = await queryOne<{ id: string }>(
    `select id from public.document_folders where id = $1 and is_archived = false limit 1`,
    [id],
  );
  return row !== null;
}

/**
 * Is `targetId` inside the subtree of `ancestorId` (i.e. equal to, or a
 * descendant of, ancestorId)? Used to reject folder moves that would create a
 * cycle. Walks parent_folder_id upward from target via a recursive CTE.
 */
export async function isFolderInSubtree(targetId: string, ancestorId: string): Promise<boolean> {
  if (targetId === ancestorId) return true;
  const row = await queryOne<{ hit: boolean }>(
    `with recursive chain as (
       select id, parent_folder_id from public.document_folders where id = $1
       union all
       select f.id, f.parent_folder_id
         from public.document_folders f
         join chain c on f.id = c.parent_folder_id
     )
     select true as hit from chain where id = $2 limit 1`,
    [targetId, ancestorId],
  );
  return row !== null;
}

export async function createDocumentFolder(
  fields: Pick<DocumentFolderWritableFields, 'name'> & { parent_folder_id?: string | null },
  createdBy: string,
): Promise<DocumentFolder> {
  const row = await queryOne<DocumentFolder>(
    `insert into public.document_folders (name, parent_folder_id, created_by)
     values ($1, $2, $3)
     returning ${FOLDER_COLUMNS}`,
    [fields.name, fields.parent_folder_id ?? null, createdBy],
  );
  if (!row) throw new Error('failed_to_create_document_folder');
  return row;
}

export async function updateDocumentFolder(
  id: string,
  data: Partial<DocumentFolderWritableFields> & { is_archived?: boolean },
): Promise<DocumentFolder | null> {
  const rec = { ...data } as Record<string, unknown>;
  const set: string[] = [];
  const vals: unknown[] = [id];

  for (const c of ['name', 'parent_folder_id', 'is_archived'] as const) {
    if (c in rec && rec[c] !== undefined) {
      vals.push(rec[c]);
      set.push(`${c} = $${vals.length}`);
    }
  }

  if (set.length === 0) {
    const existing = await queryOne<DocumentFolder>(
      `select ${FOLDER_COLUMNS} from public.document_folders where id = $1 limit 1`,
      [id],
    );
    return existing;
  }

  return queryOne<DocumentFolder>(
    `update public.document_folders set ${set.join(', ')} where id = $1 returning ${FOLDER_COLUMNS}`,
    vals,
  );
}

/** Soft-delete: archive the folder (is_archived = true). Row retained. Idempotent. */
export async function softDeleteDocumentFolder(id: string): Promise<boolean> {
  const row = await queryOne<{ id: string }>(
    `update public.document_folders set is_archived = true where id = $1 returning id`,
    [id],
  );
  return row !== null;
}

// ── Documents ──────────────────────────────────────────────────────────────────
export async function listDocuments(filters: DocumentListFilters): Promise<DocumentWithMeta[]> {
  const where: string[] = [];
  const vals: unknown[] = [];

  if (!filters.includeArchived) where.push('d.is_archived = false');

  if (filters.folderId === null) {
    where.push('d.folder_id is null');
  } else if (filters.folderId !== undefined) {
    vals.push(filters.folderId);
    where.push(`d.folder_id = $${vals.length}`);
  }
  if (filters.entityType) {
    vals.push(filters.entityType);
    where.push(`d.entity_type = $${vals.length}`);
  }
  if (filters.entityId) {
    vals.push(filters.entityId);
    where.push(`d.entity_id = $${vals.length}`);
  }

  const whereSql = where.length ? `where ${where.join(' and ')}` : '';
  const r = await query<DocumentWithMeta>(
    `select ${prefixed(DOC_COLUMNS, 'd')},
            uu.full_name as uploaded_by_name
       from public.documents d
       left join public.users uu on uu.id = d.uploaded_by
       ${whereSql}
       order by d.created_at desc`,
    vals,
  );
  return r.rows;
}

export async function getDocumentById(id: string): Promise<DocumentWithMeta | null> {
  return queryOne<DocumentWithMeta>(
    `select ${prefixed(DOC_COLUMNS, 'd')},
            uu.full_name as uploaded_by_name
       from public.documents d
       left join public.users uu on uu.id = d.uploaded_by
      where d.id = $1
      limit 1`,
    [id],
  );
}

export async function insertDocument(input: {
  fileName: string;
  storagePath: string;
  mimeType: string | null;
  sizeBytes: number | null;
  folderId: string | null;
  entityType: string | null;
  entityId: string | null;
  uploadedBy: string;
}): Promise<DocumentRow> {
  const row = await queryOne<DocumentRow>(
    `insert into public.documents
       (file_name, storage_path, mime_type, size_bytes, folder_id, entity_type, entity_id, uploaded_by)
     values ($1,$2,$3,$4,$5,$6,$7,$8)
     returning ${DOC_COLUMNS}`,
    [
      input.fileName,
      input.storagePath,
      input.mimeType,
      input.sizeBytes,
      input.folderId,
      input.entityType,
      input.entityId,
      input.uploadedBy,
    ],
  );
  if (!row) throw new Error('failed_to_insert_document');
  return row;
}

export async function updateDocument(
  id: string,
  data: Partial<DocumentWritableFields> & { is_archived?: boolean },
): Promise<DocumentRow | null> {
  const rec = { ...data } as Record<string, unknown>;
  const set: string[] = [];
  const vals: unknown[] = [id];

  for (const c of ['file_name', 'folder_id', 'entity_type', 'entity_id', 'is_archived'] as const) {
    if (c in rec && rec[c] !== undefined) {
      vals.push(rec[c]);
      set.push(`${c} = $${vals.length}`);
    }
  }

  if (set.length === 0) {
    const existing = await queryOne<DocumentRow>(
      `select ${DOC_COLUMNS} from public.documents where id = $1 limit 1`,
      [id],
    );
    return existing;
  }

  return queryOne<DocumentRow>(
    `update public.documents set ${set.join(', ')} where id = $1 returning ${DOC_COLUMNS}`,
    vals,
  );
}

/** Soft-delete: archive the document (is_archived = true). Bytes are retained in storage. */
export async function softDeleteDocument(id: string): Promise<boolean> {
  const row = await queryOne<{ id: string }>(
    `update public.documents set is_archived = true where id = $1 returning id`,
    [id],
  );
  return row !== null;
}

/**
 * Hard-delete: permanently remove the row. Used by entity-scoped attachments
 * (e.g. debtor documents) where the caller also removes the storage object, so
 * nothing should linger. Returns true if a row was deleted.
 */
export async function hardDeleteDocument(id: string): Promise<boolean> {
  const row = await queryOne<{ id: string }>(
    `delete from public.documents where id = $1 returning id`,
    [id],
  );
  return row !== null;
}
