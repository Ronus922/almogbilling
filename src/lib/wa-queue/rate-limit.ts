import type { Pool, PoolClient } from 'pg';

type Q = Pool | PoolClient;

// Durable, shared outbound rate limiter. Sends are logged to wa_send_log; the
// limiter counts sends in the trailing 60s per bucket (the sending instance).
// Because it lives in the DB, pacing survives worker restarts and stays correct
// even if more than one worker runs — every worker reads/writes the same rows.
// This replaces the scattered in-memory setTimeout sleeps in the old broadcast /
// bulk-send / reminders paths with one central policy.

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

/** Opportunistic prune so wa_send_log stays small (older than 10 min is useless). */
export async function pruneSendLog(q: Q, bucket: string): Promise<void> {
  await q.query(
    `delete from public.wa_send_log where bucket = $1 and sent_at < now() - interval '10 minutes'`,
    [bucket],
  );
}
