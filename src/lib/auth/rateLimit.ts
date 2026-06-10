import 'server-only';
import { query, queryOne } from '@/lib/db';

/**
 * DB-backed sliding-window rate limiter for authentication entry points
 * (login, forgot-password, accept-invite). Each attempt records a row in
 * public.auth_rate_limits keyed by an opaque bucket string; a check counts
 * the hits inside the window. Survives multi-process / restart (unlike an
 * in-memory map) and needs no external service.
 */

export interface RateLimitResult {
  allowed: boolean;
  retryAfterSec: number;
}

/**
 * Best-effort client IP behind nginx. Trusts x-forwarded-for's first hop
 * (nginx sets it); falls back to x-real-ip, then a sentinel. Only used as a
 * rate-limit bucket key — never for authorization.
 */
export function clientIp(req: Request): string {
  const xff = req.headers.get('x-forwarded-for');
  if (xff) {
    const first = xff.split(',')[0]?.trim();
    if (first) return first;
  }
  return req.headers.get('x-real-ip')?.trim() || 'unknown';
}

/**
 * Records an attempt for `bucket` and returns whether it is allowed under
 * `max` hits per `windowSec`. The current attempt counts toward the limit:
 * once `max` attempts exist in the window, further attempts are blocked until
 * the window slides. Old rows for the bucket are pruned opportunistically.
 */
export async function checkRateLimit(
  bucket: string,
  opts: { max: number; windowSec: number },
): Promise<RateLimitResult> {
  const { max, windowSec } = opts;
  const sinceIso = new Date(Date.now() - windowSec * 1000).toISOString();

  // Prune this bucket's stale hits so the table stays small.
  await query(`delete from public.auth_rate_limits where bucket = $1 and hit_at <= $2`, [
    bucket,
    sinceIso,
  ]);

  const row = await queryOne<{ c: number }>(
    `select count(*)::int as c from public.auth_rate_limits where bucket = $1 and hit_at > $2`,
    [bucket, sinceIso],
  );
  const count = row?.c ?? 0;

  if (count >= max) {
    return { allowed: false, retryAfterSec: windowSec };
  }

  await query(`insert into public.auth_rate_limits (bucket) values ($1)`, [bucket]);
  return { allowed: true, retryAfterSec: 0 };
}

/** Clears a bucket's attempts — call after a SUCCESSFUL auth so a legitimate
 * user is never locked out by their own earlier failures. */
export async function clearRateLimit(bucket: string): Promise<void> {
  await query(`delete from public.auth_rate_limits where bucket = $1`, [bucket]);
}
