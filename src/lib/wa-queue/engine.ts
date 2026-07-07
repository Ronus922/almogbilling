import type { Pool } from 'pg';
import type { Recipient } from './types';
import type { WaProvider } from './provider';
import { classifyError, backoffSeconds } from './errors';
import { underRateLimit, recordSend } from './rate-limit';

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

/** Send one claimed ('processing') item, respecting the shared rate limit, and
 *  persist the outcome. Never sends twice for one row (the row is leased to us). */
export async function processRecipient(
  pool: Pool,
  provider: WaProvider,
  item: Recipient,
  creds: SendCreds,
  bucket: string,
  perMin: number,
  opts: { backoffBaseSec?: number } = {},
): Promise<ProcessResult> {
  const base = { recipientId: item.id, campaignId: item.campaign_id };

  // Rate gate — if the bucket is saturated, release the lease and re-queue with a
  // short delay so another tick (or worker) picks it up when capacity frees.
  if (!(await underRateLimit(pool, bucket, perMin))) {
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
  await recordSend(pool, bucket);

  const res = await provider.send({
    instanceId: creds.instanceId,
    token: creds.token,
    apiUrl: creds.apiUrl,
    chatId: item.chat_id,
    message: item.payload,
  });

  if (res.ok) {
    await pool.query(
      `update public.wa_campaign_recipients
          set status='sent', provider_message_id=$2, sent_at=now(),
              lease_expires_at=null, last_error=null, error_class=null
        where id=$1`,
      [item.id, res.providerMessageId],
    );
    return { ...base, outcome: 'sent' };
  }

  const cls = classifyError(new Error(res.message), { status: res.status, body: res.body });
  const canRetry = cls.retryable && item.attempt_count < item.max_attempts;
  if (canRetry) {
    const delay = backoffSeconds(item.attempt_count, opts.backoffBaseSec ?? 5);
    await pool.query(
      `update public.wa_campaign_recipients
          set status='pending', worker_id=null, lease_expires_at=null,
              processing_started_at=null, last_error=$2, error_class=$3,
              next_attempt_at = now() + ($4 || ' seconds')::interval
        where id=$1`,
      [item.id, cls.message.slice(0, 500), cls.errorClass, String(delay)],
    );
    return { ...base, outcome: 'retry' };
  }

  await pool.query(
    `update public.wa_campaign_recipients
        set status='failed', failed_at=now(), lease_expires_at=null,
            last_error=$2, error_class=$3
      where id=$1`,
    [item.id, cls.message.slice(0, 500), cls.errorClass],
  );
  return { ...base, outcome: 'failed' };
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
