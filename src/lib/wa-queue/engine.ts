import type { Pool } from 'pg';
import type { Recipient } from './types';
import type { WaProvider, SendResult } from './provider';
import { classifyError, backoffSeconds, type Classified } from './errors';
import { underRateLimit, recordSend } from './rate-limit';
import {
  planSteps, wireFileName, asciiLeaf, hasUsableUrl,
  type CampaignAttachment, type AttachmentReader,
} from './attachments';
import { GREEN_API_MAX_FILE_BYTES } from '@/lib/constants/whatsappAttachments';

// The worker's core: atomic claim (FOR UPDATE SKIP LOCKED) → send → record, plus
// lease recovery and per-campaign reconciliation. Pure functions over a pg Pool,
// so the same code runs in the worker and in the tests (no Next 'server-only').

const DEFAULT_LEASE_SEC = 60;

export interface DrainOpts {
  workerId: string;
  batchSize?: number;
  leaseSec?: number;
}

/** Atomically claim up to `batchSize` due, pending items from RUNNING campaigns.
 *  SKIP LOCKED guarantees two workers never claim the same row. */
export async function claimBatch(pool: Pool, opts: DrainOpts): Promise<Recipient[]> {
  const batch = opts.batchSize ?? 10;
  const lease = opts.leaseSec ?? DEFAULT_LEASE_SEC;
  const r = await pool.query<Recipient>(
    `
    with claimable as (
      select r.id
        from public.wa_campaign_recipients r
        join public.wa_campaigns c on c.id = r.campaign_id
       where r.status = 'pending'
         and r.next_attempt_at <= now()
         and c.status = 'running'
       order by r.next_attempt_at
       for update of r skip locked
       limit $2
    )
    update public.wa_campaign_recipients r
       set status = 'processing',
           worker_id = $1,
           processing_started_at = now(),
           lease_expires_at = now() + ($3 || ' seconds')::interval,
           send_attempted_at = null,
           attempt_count = r.attempt_count + 1
      from claimable cl
     where r.id = cl.id
     returning r.*;
    `,
    [opts.workerId, batch, String(lease)],
  );
  return r.rows;
}

export interface ProcessResult {
  outcome: 'sent' | 'retry' | 'failed' | 'paced';
  recipientId: string;
  campaignId: string;
}

/** Sending credentials for the real provider (ignored by the mock). Resolved by
 *  the worker per campaign from its instance_id. */
export interface SendCreds { instanceId: string; token: string; apiUrl?: string }

export interface ProcessOpts {
  backoffBaseSec?: number;
  /** The campaign's attachments in sort_order (none = text-only broadcast). */
  attachments?: CampaignAttachment[];
  /** Bytes reader for the per-recipient upload fallback (no shared link). */
  readAttachment?: AttachmentReader;
}

/** Send one claimed ('processing') item, respecting the shared rate limit, and
 *  persist the outcome. Never sends twice for one row (the row is leased to us).
 *
 *  A recipient is the TEXT followed by the campaign's files in sort_order (one
 *  provider call each; with a single file the text is its caption). Progress is
 *  persisted after every call (provider_message_id for the text,
 *  attachments_sent for the files), so a retry after a mid-way failure resumes
 *  with the parts that were NOT delivered — never a duplicate. */
export async function processRecipient(
  pool: Pool,
  provider: WaProvider,
  item: Recipient,
  creds: SendCreds,
  bucket: string,
  perMin: number,
  opts: ProcessOpts = {},
): Promise<ProcessResult> {
  const base = { recipientId: item.id, campaignId: item.campaign_id };
  const files = opts.attachments ?? [];
  const steps = planSteps(item, files);

  // Rate gate — if the bucket is saturated, release the lease and re-queue with a
  // short delay so another tick (or worker) picks it up when capacity frees. One
  // recipient = one unit of the window, however many files ride along.
  if (steps.length > 0 && !(await underRateLimit(pool, bucket, perMin))) {
    await pool.query(
      `update public.wa_campaign_recipients
          set status='pending', worker_id=null, lease_expires_at=null,
              processing_started_at=null, attempt_count = attempt_count - 1,
              next_attempt_at = now() + interval '2 seconds'
        where id=$1`,
      [item.id],
    );
    return { ...base, outcome: 'paced' };
  }

  // Mark "about to send" and count the attempt toward the rate window BEFORE the
  // network call — so a crash mid-send is detectable (indeterminate) on recovery.
  await pool.query(`update public.wa_campaign_recipients set send_attempted_at=now() where id=$1`, [item.id]);
  if (steps.length > 0) await recordSend(pool, bucket);

  let providerMessageId = item.provider_message_id;
  for (const step of steps) {
    let res: SendResult;
    let label: string | null = null;
    if (step.kind === 'text') {
      res = await provider.send({
        instanceId: creds.instanceId, token: creds.token, apiUrl: creds.apiUrl,
        chatId: item.chat_id, message: item.payload,
      });
    } else {
      const file = files[step.index];
      label = file.original_name;
      res = await sendAttachment(provider, creds, item.chat_id, file, step.caption, opts.readAttachment);
    }

    if (!res.ok) {
      const cls = classifyError(new Error(res.message), { status: res.status, body: res.body });
      return persistFailure(pool, item, cls, label, opts.backoffBaseSec ?? 5).then((outcome) => ({ ...base, outcome }));
    }

    // Persist progress right away: the text's id (also what the delivery webhook
    // matches on), or the count of files delivered so far.
    if (step.kind === 'text' || step.caption !== undefined) {
      providerMessageId = res.providerMessageId;
      await pool.query(
        `update public.wa_campaign_recipients
            set provider_message_id=$2, attachments_sent = greatest(attachments_sent, $3)
          where id=$1`,
        [item.id, providerMessageId, step.kind === 'file' ? 1 : 0],
      );
    } else {
      await pool.query(
        `update public.wa_campaign_recipients set attachments_sent=$2 where id=$1`,
        [item.id, step.index + 1],
      );
    }
  }

  await pool.query(
    `update public.wa_campaign_recipients
        set status='sent', provider_message_id=$2, sent_at=now(),
            lease_expires_at=null, last_error=null, error_class=null
      where id=$1`,
    [item.id, providerMessageId],
  );
  return { ...base, outcome: 'sent' };
}

/** One file to one recipient: the shared Green API link when it is usable
 *  (uploadFile once per campaign → sendFileByUrl), else the per-recipient
 *  upload fallback (sendFileByUpload) when the bytes can be read. */
async function sendAttachment(
  provider: WaProvider,
  creds: SendCreds,
  chatId: string,
  file: CampaignAttachment,
  caption: string | undefined,
  reader: AttachmentReader | undefined,
): Promise<SendResult> {
  const common = { instanceId: creds.instanceId, token: creds.token, apiUrl: creds.apiUrl, chatId };
  const captionArg = caption ? { caption } : {};
  if (file.green_api_url && hasUsableUrl(file)) {
    return provider.sendFileByUrl({
      ...common, urlFile: file.green_api_url, fileName: wireFileName(file.original_name), ...captionArg,
    });
  }
  if (!reader) {
    // Nothing to send from: no shared link and no way to read the bytes. A 4xx
    // status makes classifyError treat it as permanent (a retry cannot help).
    return { ok: false, status: 400, message: 'no shared file link and no attachment reader' };
  }
  let bytes: Buffer;
  try {
    bytes = await reader(file);
  } catch (err) {
    return { ok: false, message: `attachment read failed: ${(err as Error).message}` }; // transient → retry
  }
  if (bytes.byteLength > GREEN_API_MAX_FILE_BYTES) {
    return { ok: false, status: 413, message: 'file exceeds the Green API 100MB limit' };
  }
  return provider.sendFileByUpload({
    ...common, bytes, mimeType: file.mime_type,
    fileName: wireFileName(asciiLeaf(file.object_key)), displayName: wireFileName(file.original_name), ...captionArg,
  });
}

/** Retry (backoff) or fail the item, recording WHICH part failed. */
async function persistFailure(
  pool: Pool, item: Recipient, cls: Classified, fileLabel: string | null, backoffBaseSec: number,
): Promise<'retry' | 'failed'> {
  const message = (fileLabel ? `קובץ «${fileLabel}»: ${cls.message}` : cls.message).slice(0, 500);
  const canRetry = cls.retryable && item.attempt_count < item.max_attempts;
  if (canRetry) {
    const delay = backoffSeconds(item.attempt_count, backoffBaseSec);
    await pool.query(
      `update public.wa_campaign_recipients
          set status='pending', worker_id=null, lease_expires_at=null,
              processing_started_at=null, last_error=$2, error_class=$3,
              next_attempt_at = now() + ($4 || ' seconds')::interval
        where id=$1`,
      [item.id, message, cls.errorClass, String(delay)],
    );
    return 'retry';
  }
  await pool.query(
    `update public.wa_campaign_recipients
        set status='failed', failed_at=now(), lease_expires_at=null,
            last_error=$2, error_class=$3
      where id=$1`,
    [item.id, message, cls.errorClass],
  );
  return 'failed';
}

export interface RecoveryResult { requeued: number; indeterminate: number }

/** Recover items whose lease expired (a worker died mid-flight). Exactly-once
 *  safe: an item that crashed BEFORE the send is re-queued; one that crashed
 *  AFTER a send was attempted is marked 'indeterminate' and NOT auto-resent (only
 *  an explicit operator retry can re-send it), so recovery never duplicates. */
export async function recoverLeases(pool: Pool): Promise<RecoveryResult> {
  const requeued = await pool.query(
    `update public.wa_campaign_recipients
        set status='pending', worker_id=null, lease_expires_at=null,
            processing_started_at=null, next_attempt_at=now()
      where status='processing' and lease_expires_at < now() and send_attempted_at is null`,
  );
  const indet = await pool.query(
    `update public.wa_campaign_recipients
        set status='failed', failed_at=now(), lease_expires_at=null,
            error_class='indeterminate',
            last_error='lease expired after a send was attempted; not auto-resent to avoid a duplicate — retry manually if it did not arrive'
      where status='processing' and lease_expires_at < now() and send_attempted_at is not null`,
  );
  return { requeued: requeued.rowCount ?? 0, indeterminate: indet.rowCount ?? 0 };
}

/** Recompute counters + terminal status for a campaign from its recipient rows. */
export async function reconcile(pool: Pool, campaignId: string): Promise<void> {
  await pool.query(`select public.reconcile_wa_campaign($1)`, [campaignId]);
}

/** Detect campaigns stuck in a non-terminal state with no active work — a dead
 *  process can no longer strand a campaign in 'running'. Returns affected ids. */
export async function reconcileStale(pool: Pool): Promise<string[]> {
  const r = await pool.query<{ id: string }>(
    `select id from public.wa_campaigns where status in ('running','queued')`,
  );
  for (const row of r.rows) await reconcile(pool, row.id);
  return r.rows.map((x) => x.id);
}
