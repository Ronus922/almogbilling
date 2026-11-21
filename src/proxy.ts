import { NextResponse, type NextRequest } from 'next/server';
import { SESSION_COOKIE } from '@/lib/constants';

const PROTECTED = ['/dashboard', '/overview'];

// The proxy holds only the opaque session cookie — it cannot tell a live
// session from a dead one (expired, deleted, its user disabled). So it makes
// ONE decision only: no cookie on a protected path → /login.
//
// "Already signed in, send them home" is decided where the session can be
// validated: the auth pages call redirectIfSignedIn() (src/lib/auth/signedIn.ts).
// Until 21/11/2026 the proxy bounced ANY cookie-holder off /login to `/`, and
// `/` sent a dead cookie back to /login — an endless loop (ERR_TOO_MANY_REDIRECTS)
// that only clearing the browser's cookies broke, and that an installed iPhone
// web app could not break at all.
export function proxy(req: NextRequest) {
  const sid = req.cookies.get(SESSION_COOKIE)?.value;
  const { pathname } = req.nextUrl;
  const onProtected = PROTECTED.some((p) => pathname === p || pathname.startsWith(p + '/'));
  if (!sid && onProtected) {
    return NextResponse.redirect(new URL('/login', req.url));
  }
  return NextResponse.next();
}

export const config = {
  matcher: ['/dashboard/:path*', '/overview/:path*'],
};
