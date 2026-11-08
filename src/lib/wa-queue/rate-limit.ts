import type { Pool, PoolClient } from 'pg';

type Q = Pool | PoolClient;

// Durable, shared outbound rate limiter. Sends are logged to wa_send_log; the
// limiter counts sends in the trailing 60s per bucket (the sending instance).
// Because it lives in the DB, pacing survives worker restarts and stays correct
// even if more than one worker runs — every worker reads/writes the same rows.
// This replaces the scattered in-memory setTimeout sleeps in the old broadcast /
// bulk-send / reminders paths with one central policy.
//
// The unit is a RECIPIENT, not a provider call: a broadcast with attachments
// sends several Green API messages per recipient (text + one per file) but is
// counted once, so rate_per_min keeps its meaning — recipients per minute. Green
// API's own send queue spaces the individual messages on its side.

/** The WhatsApp pace of a regular broadcast — wa_campaigns.rate_per_min's DB
 *  default (the compose form never sends another value). There is no
 *  per-instance setting: the limit is a column of each campaign and the window
 *  it is compared against is shared by everything on the instance. The SMS
 *  channel's WhatsApp fallback has no WhatsApp campaign row of its own to read
 *  this from (its own rate_per_min is the SMS pace), so it uses this. Kept in
 *  step with the column default by tests/wa-queue-sms-rate.test.ts. */
export const DEFAULT_WA_RATE_PER_MIN = 12;

export async function underRateLimit(q: Q, bucket: string, perMin: number): Promise<boolean> {
  const r = await q.query<{ c: string }>(
    `select count(*)::int as c from public.wa_send_log
      where bucket = $1 and sent_at > now() - interval '60 seconds'`,
    [bucket],
  );
  return Number(r.rows[0]?.c ?? 0) < perMin;
}

export async function recordSend(q: Q, bucket: string): Promise<void> {
  await q.query(`insert into public.wa_send_log (bucket) values ($1)`, [bucket]);
}

export interface WindowWaitOpts {
  /** Called as soon as the window turns out to be full, then about every
   *  `heartbeatMs` while still waiting — a caller streaming progress to a
   *  browser uses it to say "waiting" (and to keep the connection active). */
  onWait?: (waitedMs: number) => void;
  /** True → stop waiting (the client went away); nothing is counted. */
  aborted?: () => boolean;
  /** Injectable for tests; the default is a real timer. */
  sleep?: (ms: number) => Promise<void>;
  pollMs?: number;
  heartbeatMs?: number;
}

/**
 * For a caller that cannot be re-queued (a synchronous, request-bound send such
 * as the debtors table's bulk WhatsApp): wait until the instance's window has
 * room, then take one slot in it. Returns false only when `aborted` fired first.
 *
 * It is the same window and the same unit (one recipient) as the queue worker's
 * gate, so a broadcast, an SMS fallback and this caller running together on one
 * instance share one budget. The check and the insert are two statements, as in
 * the worker; two writers inside the same few milliseconds can overshoot by one.
 */
export async function takeWindowSlot(
  q: Q, bucket: string, perMin: number, opts: WindowWaitOpts = {},
): Promise<boolean> {
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const pollMs = opts.pollMs ?? 1000;
  const heartbeatMs = opts.heartbeatMs ?? 10_000;
  let waited = 0;
  let lastBeat = -heartbeatMs; // the first wait is announced at once
  for (;;) {
    if (opts.aborted?.()) return false;
    if (await underRateLimit(q, bucket, perMin)) {
      await recordSend(q, bucket);
      return true;
    }
    if (waited - lastBeat >= heartbeatMs) {
      opts.onWait?.(waited);
      lastBeat = waited;
    }
    await sleep(pollMs);
    waited += pollMs;
  }
}

/** Opportunistic prune so wa_send_log stays small (older than 10 min is useless). */
export async function pruneSendLog(q: Q, bucket: string): Promise<void> {
  await q.query(
    `delete from public.wa_send_log where bucket = $1 and sent_at < now() - interval '10 minutes'`,
    [bucket],
  );
}
