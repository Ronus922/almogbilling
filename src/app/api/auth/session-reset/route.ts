import { NextResponse } from 'next/server';
import { deleteSession, getActiveSessionId, getSession } from '@/lib/auth/session';
import { homePathFor } from '@/lib/auth/home';
import { appUrl } from '@/lib/config';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// GET /api/auth/session-reset (21/11/2026) — where a DEAD session cookie is
// cleared. Server Components cannot modify cookies, so `/` and the (app)
// layout send a request whose cookie names no live session here, and this
// route handler (which may) removes it and ends on /login:
//   · a live session → its role's home, untouched. A GET is linkable, so this
//     route must never sign a real session out (that is POST /api/auth/logout).
//   · a session row that is still valid but whose user was disabled → the row
//     (that one, by the cookie's own hash) and the cookie go → /login?reason=disabled.
//   · expired / deleted / unknown → the cookie goes → /login.
// It always answers with a redirect to a page that renders without a session,
// so it can never be part of a loop, even if a browser kept the cookie.
export async function GET() {
  const session = await getSession();
  if (session) {
    return NextResponse.redirect(`${appUrl()}${homePathFor(session.user.role)}`, { headers: { 'Cache-Control': 'no-store' } });
  }
  const disabled = (await getActiveSessionId()) !== null;
  await deleteSession();
  return NextResponse.redirect(`${appUrl()}${disabled ? '/login?reason=disabled' : '/login'}`, {
    headers: { 'Cache-Control': 'no-store' },
  });
}
