import { NextResponse } from 'next/server';
import { endPortalSession } from '@/lib/portal/session';

export const runtime = 'nodejs';

// POST /api/portal/logout — revokes the portal session row, clears the cookie and
// logs `session_revoked`. Idempotent: no cookie / an already-revoked token is a
// 200 too, so a double click never shows an error.
export async function POST() {
  await endPortalSession();
  return NextResponse.json({ ok: true });
}
