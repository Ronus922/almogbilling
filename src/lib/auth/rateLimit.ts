import 'server-only';
import { query, withTransaction } from '@/lib/db';

/**
 * DB-backed sliding-window rate limiter (login, the portal and chip-order
 * OTP, the public quote link, …). Each attempt records a row in
 * public.auth_rate_limits keyed by an opaque bucket string; a check counts
 * the hits inside the window. Survives multi-process / restart (unlike an
 * in-memory map) and needs no external service. Bucket keys that carry an IP
 * take it from getClientIp (src/lib/http/clientIp.ts) — never from a header
 * the client controls.
 */

export interface RateLimitResult {
  allowed: boolean;
  retryAfterSec: number;
}

/** The two-key advisory-lock namespace of the limiter ("rate" in ASCII) —
 *  a lock space of its own, apart from the one-key locks (scrapeLock.ts). */
const RATE_LIMIT_LOCK_NS = 0x72617465;

/**
 * Records an attempt for `bucket` and returns whether it is allowed under
 * `max` hits per `windowSec` (a sliding window over public.auth_rate_limits).
 * The current attempt counts toward the limit: once `max` attempts exist in
 * the window, further attempts are blocked until the window slides.
 *
 * ATOMIC (13/11/2026): the count, the decision and the recording are ONE
 * statement, run under a per-bucket transaction lock (pg_advisory_xact_lock).
 * Before, the count and the insert were separate queries, so N requests
 * arriving together all counted the same "max - 1" and all passed. Now the
 * second caller of a bucket waits for the first to commit and then counts its
 * hit — 20 parallel calls against max 5 let exactly 5 through. The lock is
 * transaction-scoped, so it is safe through the pooler (DATABASE_URL) and is
 * released at COMMIT. Stale hits of the bucket are pruned in the same
 * statement.
 */
export async function checkRateLimit(
  bucket: string,
  opts: { max: number; windowSec: number },
): Promise<RateLimitResult> {
  const { max, windowSec } = opts;
  const allowed = await withTransaction(async (client) => {
    await client.query('select pg_advisory_xact_lock($1::int, hashtext($2))', [RATE_LIMIT_LOCK_NS, bucket]);
    const r = await client.query<{ allowed: boolean }>(
      `with pruned as (
         delete from public.auth_rate_limits
          where bucket = $1 and hit_at <= now() - make_interval(secs => $3)
       ), hit as (
         insert into public.auth_rate_limits (bucket)
         select $1
          where (select count(*) from public.auth_rate_limits
                  where bucket = $1 and hit_at > now() - make_interval(secs => $3)) < $2
         returning 1
       )
       select exists (select 1 from hit) as allowed`,
      [bucket, max, windowSec],
    );
    return r.rows[0]?.allowed === true;
  });
  return allowed ? { allowed: true, retryAfterSec: 0 } : { allowed: false, retryAfterSec: windowSec };
}

/** Clears a bucket's attempts — call after a SUCCESSFUL auth so a legitimate
 * user is never locked out by their own earlier failures. */
export async function clearRateLimit(bucket: string): Promise<void> {
  await query(`delete from public.auth_rate_limits where bucket = $1`, [bucket]);
}
