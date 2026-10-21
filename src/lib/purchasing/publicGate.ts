import 'server-only';
import { NextResponse } from 'next/server';
import { checkRateLimit, clientIp } from '@/lib/auth/rateLimit';

// The unauthenticated supplier link (/quote/<token>) is the only part of
// purchasing a stranger can reach, so every call to it passes this gate:
//   • per IP, ALL requests (hits on unknown tokens included — that is the
//     enumeration attempt) 120 / 10 min;
//   • per token, WRITES 40 / hour.
// Reads and writes of a valid link are far below both.

export async function publicReadGate(req: Request): Promise<NextResponse | null> {
  const r = await checkRateLimit(`pq:ip:${clientIp(req)}`, { max: 120, windowSec: 600 });
  if (r.allowed) return null;
  return NextResponse.json(
    { error: 'יותר מדי בקשות — נסו שוב בעוד כמה דקות' },
    { status: 429, headers: { 'Retry-After': String(r.retryAfterSec) } },
  );
}

export async function publicWriteGate(req: Request, token: string): Promise<NextResponse | null> {
  const blocked = await publicReadGate(req);
  if (blocked) return blocked;
  const r = await checkRateLimit(`pq:w:${token.slice(0, 16)}`, { max: 40, windowSec: 3600 });
  if (r.allowed) return null;
  return NextResponse.json(
    { error: 'יותר מדי עדכונים — נסו שוב מאוחר יותר' },
    { status: 429, headers: { 'Retry-After': String(r.retryAfterSec) } },
  );
}

/** Never cached, never indexed, never leaks the token in a Referer. */
export const PUBLIC_HEADERS = {
  'Cache-Control': 'private, no-store',
  'X-Robots-Tag': 'noindex, nofollow',
  'Referrer-Policy': 'no-referrer',
} as const;
