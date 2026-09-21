import 'server-only';
import { query, queryOne } from '@/lib/db';
import { buildProxyUrl } from '@/lib/storage/server';
import { FINANCE_DRIVE_MAX_ATTEMPTS, type DriveStatus, type FinKind } from '@/lib/constants/finance';
import type { DriveBackupStats, FinDocumentView } from '@/lib/types/finance';

export type { FinDocumentView };

// Receipts/invoices of an entry (fin_documents). Same lifecycle as the WhatsApp
// attachments: a row is STAGED at upload time (entry_id NULL, owned by
// uploaded_by) and linked to the entry on save. Every linked document is then
// backed up to Google Drive in the background (drive_status).

export interface FinDocument {
  id: string;
  entry_id: string | null;
  uploaded_by: string | null;
  bucket: string;
  object_key: string;
  original_name: string;
  mime: string;
  size: number;
  drive_file_id: string | null;
  drive_status: DriveStatus;
  drive_error: string | null;
  drive_attempts: number;
  object_deleted_at: string | null;
  created_at: string;
}

const COLS = `
  id, entry_id, uploaded_by, bucket, object_key, original_name, mime, size::int as size,
  drive_file_id, drive_status, drive_error, drive_attempts, object_deleted_at, created_at`;

export function toDocumentView(d: FinDocument): FinDocumentView {
  return {
    id: d.id,
    original_name: d.original_name,
    mime: d.mime,
    size: d.size,
    url: buildProxyUrl('finance-receipts', d.object_key),
    drive_status: d.drive_status,
    drive_error: d.drive_error,
    drive_attempts: d.drive_attempts,
    drive_file_id: d.drive_file_id,
  };
}

export async function insertStagedDocument(input: {
  uploadedBy: string; objectKey: string; originalName: string; mime: string; size: number;
}): Promise<FinDocument> {
  const r = await query<FinDocument>(
    `insert into public.fin_documents (uploaded_by, object_key, original_name, mime, size)
     values ($1, $2, $3, $4, $5)
     returning ${COLS}`,
    [input.uploadedBy, input.objectKey, input.originalName, input.mime, input.size],
  );
  return r.rows[0];
}

/** Remove a STAGED document the actor uploaded; returns the row (so the caller
 *  can delete the object) or null when it is not theirs / already linked. */
export async function deleteStagedDocument(id: string, uploadedBy: string): Promise<FinDocument | null> {
  const r = await query<FinDocument>(
    `delete from public.fin_documents
      where id = $1 and entry_id is null and uploaded_by = $2
      returning ${COLS}`,
    [id, uploadedBy],
  );
  return r.rows[0] ?? null;
}

/** Remove a LINKED document of an entry (the edit sheet's X). Any finance
 *  editor may do it; the Drive copy, if one was made, is left as the backup. */
export async function deleteEntryDocument(id: string, entryId: string): Promise<FinDocument | null> {
  const r = await query<FinDocument>(
    `delete from public.fin_documents
      where id = $1 and entry_id = $2
      returning ${COLS}`,
    [id, entryId],
  );
  return r.rows[0] ?? null;
}

/** Link staged documents to the entry. Returns how many rows were linked, so
 *  the caller can tell that one was not the actor's (or its bytes are gone). */
export async function linkDocuments(entryId: string, ids: string[], uploadedBy: string): Promise<number> {
  if (ids.length === 0) return 0;
  const r = await query(
    `update public.fin_documents
        set entry_id = $1
      where id = any($2::uuid[]) and entry_id is null and uploaded_by = $3
        and object_deleted_at is null`,
    [entryId, ids, uploadedBy],
  );
  return r.rowCount ?? 0;
}

export async function listDocumentsForEntries(entryIds: string[]): Promise<Map<string, FinDocument[]>> {
  const out = new Map<string, FinDocument[]>();
  if (entryIds.length === 0) return out;
  const r = await query<FinDocument>(
    `select ${COLS} from public.fin_documents
      where entry_id = any($1::uuid[]) and object_deleted_at is null
      order by created_at`,
    [entryIds],
  );
  for (const row of r.rows) {
    if (!row.entry_id) continue;
    const list = out.get(row.entry_id);
    if (list) list.push(row);
    else out.set(row.entry_id, [row]);
  }
  return out;
}

export async function getDocument(id: string): Promise<FinDocument | null> {
  return queryOne<FinDocument>(`select ${COLS} from public.fin_documents where id = $1`, [id]);
}

// ── Google Drive backup bookkeeping ───────────────────────────────────────────

/** Everything the Drive upload needs to name and file the document. */
export interface DriveCandidate extends FinDocument {
  entry_kind: FinKind;
  period_month: string;
  payment_date: string | null;
  amount: number;
  category_name: string;
}

const CANDIDATE_SQL = `
  select d.id, d.entry_id, d.uploaded_by, d.bucket, d.object_key, d.original_name, d.mime,
         d.size::int as size, d.drive_file_id, d.drive_status, d.drive_error, d.drive_attempts,
         d.object_deleted_at, d.created_at,
         e.kind as entry_kind, e.period_month::text as period_month, e.payment_date::text as payment_date,
         e.amount::float8 as amount, c.name as category_name
    from public.fin_documents d
    join public.fin_entries e on e.id = d.entry_id
    join public.fin_categories c on c.id = e.category_id`;

export async function getDriveCandidate(id: string): Promise<DriveCandidate | null> {
  return queryOne<DriveCandidate>(`${CANDIDATE_SQL} where d.id = $1`, [id]);
}

/** Linked documents that still need a Drive copy and have attempts left, oldest first. */
export async function listDriveCandidates(limit: number): Promise<DriveCandidate[]> {
  const r = await query<DriveCandidate>(
    `${CANDIDATE_SQL}
      where d.drive_status <> 'done' and d.drive_attempts < $1
        and d.object_deleted_at is null and e.deleted_at is null
      order by d.created_at
      limit $2`,
    [FINANCE_DRIVE_MAX_ATTEMPTS, limit],
  );
  return r.rows;
}

/** Counts for the settings screen. */
export async function driveBackupStats(): Promise<DriveBackupStats> {
  const row = await queryOne<DriveBackupStats>(
    `select count(*) filter (where drive_status = 'pending')::int as pending,
            count(*) filter (where drive_status = 'failed' and drive_attempts < $1)::int as failed,
            count(*) filter (where drive_status = 'done')::int as done,
            count(*) filter (where drive_status = 'failed' and drive_attempts >= $1)::int as exhausted
       from public.fin_documents
      where entry_id is not null and object_deleted_at is null`,
    [FINANCE_DRIVE_MAX_ATTEMPTS],
  );
  return row ?? { pending: 0, failed: 0, done: 0, exhausted: 0 };
}

/** Claim one attempt: bumps the counter BEFORE the upload so a crash mid-way
 *  still counts (at worst a duplicate copy on Drive, never an endless loop). */
export async function markDriveAttempt(id: string): Promise<number> {
  const row = await queryOne<{ drive_attempts: number }>(
    `update public.fin_documents set drive_attempts = drive_attempts + 1
      where id = $1 returning drive_attempts`,
    [id],
  );
  return row?.drive_attempts ?? 0;
}

export async function markDriveDone(id: string, driveFileId: string): Promise<void> {
  await query(
    `update public.fin_documents
        set drive_status = 'done', drive_file_id = $2, drive_error = null
      where id = $1`,
    [id, driveFileId],
  );
}

export async function markDriveFailed(id: string, error: string): Promise<void> {
  await query(
    `update public.fin_documents set drive_status = 'failed', drive_error = $2 where id = $1`,
    [id, error.slice(0, 500)],
  );
}

/** "נסה שוב": give exhausted documents a fresh set of attempts. */
export async function resetDriveAttempts(): Promise<number> {
  const r = await query(
    `update public.fin_documents set drive_attempts = 0
      where drive_status = 'failed' and entry_id is not null and object_deleted_at is null`,
  );
  return r.rowCount ?? 0;
}
