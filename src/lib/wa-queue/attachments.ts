import type { Pool, PoolClient } from 'pg';
import { WHATSAPP_ATTACHMENT_LIMITS } from '@/lib/constants/whatsappAttachments';

// Broadcast attachments — the queue-side view (rows of wa_campaign_attachments)
// plus the PURE planning of what one recipient still needs to receive. No Next
// 'server-only' imports: this runs in the standalone worker, the API routes and
// the tests alike. Storage bytes are never read here — the worker injects an
// AttachmentReader (scripts/wa-queue-worker.ts), the routes go through
// src/lib/storage/whatsappAttachmentStorage.ts.

type Q = Pool | PoolClient;

export interface CampaignAttachment {
  id: string;
  campaign_id: string | null;
  uploaded_by: string | null;
  bucket: string;
  object_key: string;
  original_name: string;
  mime_type: string;
  size_bytes: number;
  sort_order: number;
  /** Green API uploadFile link (valid 15 days) — reused for every recipient. */
  green_api_url: string | null;
  green_api_url_expires_at: string | null;
  green_api_error: string | null;
  green_api_upload_attempts: number;
  created_at: string;
  /** Stamped by the Storage GC when it removed this row's object as
   *  `staged_old`. Non-null = the bytes are gone; the row is kept as the record
   *  of the upload and is no longer offered to a compose sheet. */
  object_deleted_at: string | null;
}

/** What the history / details API expose per attachment (+ a proxy `url`). */
export interface CampaignAttachmentSummary {
  id: string;
  original_name: string;
  mime_type: string;
  size_bytes: number;
  sort_order: number;
  bucket: string;
  object_key: string;
}

/** Reads the object bytes for an attachment (injected by the worker entrypoint). */
export type AttachmentReader = (a: Pick<CampaignAttachment, 'bucket' | 'object_key'>) => Promise<Buffer>;

const COLS = `
  id, campaign_id, uploaded_by, bucket, object_key, original_name, mime_type,
  size_bytes::int as size_bytes, sort_order, green_api_url, green_api_url_expires_at,
  green_api_error, green_api_upload_attempts, created_at, object_deleted_at`;

/** uploadFile attempts before the worker gives up on the shared link and falls
 *  back to sendFileByUpload per recipient. */
export const MAX_UPLOAD_ATTEMPTS = 3;

/** Refresh the shared link when it has less than this left (the campaign may
 *  still be draining when it would otherwise expire mid-run). */
const REFRESH_MARGIN_HOURS = 1;

// ── Rows ──────────────────────────────────────────────────────────────────────

export async function insertStagedAttachment(q: Q, input: {
  uploadedBy: string; bucket: string; objectKey: string; originalName: string; mimeType: string; sizeBytes: number;
}): Promise<CampaignAttachment> {
  const r = await q.query<CampaignAttachment>(
    `insert into public.wa_campaign_attachments
       (uploaded_by, bucket, object_key, original_name, mime_type, size_bytes)
     values ($1, $2, $3, $4, $5, $6)
     returning ${COLS}`,
    [input.uploadedBy, input.bucket, input.objectKey, input.originalName, input.mimeType, input.sizeBytes],
  );
  return r.rows[0];
}

/** Staged (not yet linked) attachments owned by `uploadedBy`, in the order of `ids`.
 *
 *  `object_deleted_at is null` keeps a row whose bytes the Storage GC has already
 *  collected out of the result. The caller compares the count with the ids it
 *  asked for and refuses the submit ("קובץ מצורף לא נמצא — הסר אותו וצרף מחדש"),
 *  which is the whole point: a compose sheet left open past the 24h staging
 *  window must fail loudly instead of broadcasting a file that no longer exists. */
export async function listStagedAttachments(q: Q, ids: string[], uploadedBy: string): Promise<CampaignAttachment[]> {
  if (ids.length === 0) return [];
  const r = await q.query<CampaignAttachment>(
    `select ${COLS} from public.wa_campaign_attachments
      where id = any($1::uuid[]) and campaign_id is null and uploaded_by = $2
        and object_deleted_at is null`,
    [ids, uploadedBy],
  );
  const byId = new Map(r.rows.map((a) => [a.id, a]));
  return ids.map((id) => byId.get(id)).filter((a): a is CampaignAttachment => a !== undefined);
}

/** Remove a staged attachment the actor uploaded; returns the row (for the
 *  object delete) or null when it is not theirs / already linked / gone. */
export async function deleteStagedAttachment(q: Q, id: string, uploadedBy: string): Promise<CampaignAttachment | null> {
  const r = await q.query<CampaignAttachment>(
    `delete from public.wa_campaign_attachments
      where id = $1 and campaign_id is null and uploaded_by = $2
      returning ${COLS}`,
    [id, uploadedBy],
  );
  return r.rows[0] ?? null;
}

/** Link staged attachments to a campaign in the given order. Runs inside the
 *  createCampaign transaction; returns how many rows were linked so the caller
 *  can refuse a submit that references a file that is not (or no longer) its own. */
export async function linkAttachments(q: Q, campaignId: string, ids: string[], uploadedBy: string): Promise<number> {
  let linked = 0;
  for (let i = 0; i < ids.length; i++) {
    const r = await q.query(
      `update public.wa_campaign_attachments
          set campaign_id = $1, sort_order = $2
        where id = $3 and campaign_id is null and uploaded_by = $4
          and object_deleted_at is null`,
      [campaignId, i, ids[i], uploadedBy],
    );
    linked += r.rowCount ?? 0;
  }
  return linked;
}

export async function listCampaignAttachments(q: Q, campaignId: string): Promise<CampaignAttachment[]> {
  const r = await q.query<CampaignAttachment>(
    `select ${COLS} from public.wa_campaign_attachments
      where campaign_id = $1 order by sort_order, created_at`,
    [campaignId],
  );
  return r.rows;
}

/** Attachments of RUNNING campaigns whose shared Green API link is missing or
 *  about to expire, and that have not exhausted their upload attempts. */
export async function listAttachmentsNeedingUpload(q: Q): Promise<CampaignAttachment[]> {
  const r = await q.query<CampaignAttachment>(
    `select ${COLS.split(',').map((c) => `a.${c.trim()}`).join(', ')}
       from public.wa_campaign_attachments a
       join public.wa_campaigns c on c.id = a.campaign_id
      where c.status = 'running'
        and a.green_api_upload_attempts < $1
        and (a.green_api_url is null
             or a.green_api_url_expires_at is null
             or a.green_api_url_expires_at < now() + ($2 || ' hours')::interval)
      order by a.campaign_id, a.sort_order`,
    [MAX_UPLOAD_ATTEMPTS, String(REFRESH_MARGIN_HOURS)],
  );
  return r.rows;
}

export async function recordUploadSuccess(q: Q, id: string, urlFile: string): Promise<void> {
  await q.query(
    `update public.wa_campaign_attachments
        set green_api_url = $2,
            green_api_url_expires_at = now() + ($3 || ' days')::interval,
            green_api_error = null,
            green_api_upload_attempts = green_api_upload_attempts + 1
      where id = $1`,
    [id, urlFile, String(WHATSAPP_ATTACHMENT_LIMITS.greenApiUrlLifetimeDays)],
  );
}

export async function recordUploadFailure(q: Q, id: string, message: string): Promise<void> {
  await q.query(
    `update public.wa_campaign_attachments
        set green_api_error = $2,
            green_api_upload_attempts = green_api_upload_attempts + 1
      where id = $1`,
    [id, message.slice(0, 500)],
  );
}

// ── Pure helpers ──────────────────────────────────────────────────────────────

/** The shared link is usable when present and not expired. */
export function hasUsableUrl(a: Pick<CampaignAttachment, 'green_api_url' | 'green_api_url_expires_at'>, nowMs = Date.now()): boolean {
  if (!a.green_api_url) return false;
  if (!a.green_api_url_expires_at) return true;
  return new Date(a.green_api_url_expires_at).getTime() > nowMs;
}

/** The last path segment of the object key — ASCII, carries the extension;
 *  what Green API's GA-Filename header and the multipart file name receive. */
export function asciiLeaf(objectKey: string): string {
  return objectKey.split('/').pop() || objectKey;
}

/** The name Green API is told. Green's own troubleshooting FAQ: WEBP must be
 *  declared as PNG in the request or the image fails / renders as a file; the
 *  bytes are unchanged. Everything else keeps the original (Hebrew ok) name. */
export function wireFileName(originalName: string): string {
  return originalName.replace(/\.webp$/i, '.png');
}

export type SendStep =
  | { kind: 'text' }
  | { kind: 'file'; index: number; caption?: string };

/** What still has to go out to ONE recipient, in order:
 *    text (unless already sent — provider_message_id set), then files from
 *    attachments_sent onward. With exactly one file whose caption fits, the
 *    text rides as that file's caption instead of a separate message. A retry
 *    therefore never re-sends a part that already went out. */
export function planSteps(
  item: { payload: string; provider_message_id: string | null; attachments_sent: number },
  files: ReadonlyArray<unknown>,
  captionMax = WHATSAPP_ATTACHMENT_LIMITS.captionMaxChars,
): SendStep[] {
  const steps: SendStep[] = [];
  const textSent = item.provider_message_id !== null;
  const singleCaption = files.length === 1 && item.payload.length <= captionMax;
  let from = Math.max(0, item.attachments_sent);
  if (!textSent) {
    if (singleCaption) {
      steps.push({ kind: 'file', index: 0, caption: item.payload });
      from = Math.max(from, 1);
    } else {
      steps.push({ kind: 'text' });
    }
  }
  for (let i = from; i < files.length; i++) steps.push({ kind: 'file', index: i });
  return steps;
}
