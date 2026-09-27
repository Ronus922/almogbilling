import 'server-only';
import { queryOne } from '@/lib/db';
import { writeAudit } from '@/lib/db/audit';
import { clientIp } from '@/lib/auth/rateLimit';
import { logger } from '@/lib/logger';

/**
 * File-access audit (security finding F9, closed 27/09/2026).
 *
 * Every time a stored object is served to a signed-in user — the /api/files
 * proxy and the two /download routes — one `file_viewed` row lands in the
 * central audit_log through writeAudit, the same path `uploaded` /
 * `document_uploaded` / `deleted` already take. Viewing and downloading are
 * the same event: the bytes left the server either way.
 *
 * Noise control: the same user opening the same object again within
 * FILE_VIEW_DEDUPE_MINUTES is NOT a new row (a preview that refreshes twenty
 * times is one view). The window is keyed on the object, so the proxy and a
 * /download route serving the same file collapse into one row too.
 *
 * FAIL-SAFE: call it after the permission check and before the response;
 * it never throws — a DB failure is logged and the file is still served.
 */
export const FILE_VIEW_ACTION = 'file_viewed';
export const FILE_VIEW_DEDUPE_MINUTES = 10;

/** The user the file is served to — what a route's require* guard returns. */
export interface FileViewActor {
  id: string;
  full_name: string | null;
  username: string;
}

/** What is being served, described the way the upload audit rows describe it. */
export interface ServedFile {
  bucket: string;
  objectKey: string;
  /** Readable (Hebrew) name from the owning table; null when there is none. */
  fileName: string | null;
  /** Parent entity exactly as the matching `uploaded` row names it
   *  (`supplier` / `document` / `fin_entry` / `issue` / `wa_campaign` / …). */
  entityType: string;
  entityId: string;
  /** Id of the owning row when the parent is not the row itself
   *  (supplier_documents / fin_documents / wa_*_attachments). */
  documentId?: string | null;
  /** Extra context mirrored from the upload rows (e.g. `debtor_id`). */
  extra?: Record<string, unknown>;
}

export async function logFileView(req: Request, actor: FileViewActor, file: ServedFile): Promise<void> {
  const fileKey = `${file.bucket}/${file.objectKey}`;
  try {
    const recent = await queryOne<{ hit: number }>(
      `select 1 as hit
         from public.audit_log
        where actor_user_id = $1
          and action = $2
          and entity_type = $3
          and entity_id = $4
          and metadata->>'file_key' = $5
          and created_at > now() - make_interval(mins => $6::int)
        limit 1`,
      [actor.id, FILE_VIEW_ACTION, file.entityType, file.entityId, fileKey, FILE_VIEW_DEDUPE_MINUTES],
    );
    if (recent) return;

    await writeAudit({
      actorUserId: actor.id,
      action: FILE_VIEW_ACTION,
      entityType: file.entityType,
      entityId: file.entityId,
      metadata: {
        ...file.extra,
        file_key: fileKey,
        bucket: file.bucket,
        object_key: file.objectKey,
        file_name: file.fileName,
        document_id: file.documentId ?? null,
        actor_name: actor.full_name ?? actor.username,
        ip: clientIp(req),
      },
    });
  } catch (err) {
    // Best-effort, exactly like writeAudit: the file is served regardless.
    logger.error('[logFileView] failed to record file view', {
      entityType: file.entityType,
      entityId: file.entityId,
      fileKey,
      err,
    });
  }
}
