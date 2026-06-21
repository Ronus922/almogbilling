import { NextResponse, type NextRequest } from 'next/server';
import { SESSION_COOKIE } from '@/lib/constants';

const AUTH_PAGES = ['/login', '/forgot-password'];
const PROTECTED = ['/dashboard', '/overview'];

export function middleware(req: NextRequest) {
  const sid = req.cookies.get(SESSION_COOKIE)?.value;
  const { pathname } = req.nextUrl;

  const onAuth = AUTH_PAGES.some((p) => pathname === p || pathname.startsWith(p + '/'));
  const onProtected = PROTECTED.some((p) => pathname === p || pathname.startsWith(p + '/'));

  // Authed user on an auth page → bounce to the root, which role-routes
  // (viewer → /dashboard, others → /overview). Middleware only holds the opaque
  // session id (no role), so the role decision is deferred to the root page.
  if (sid && onAuth) {
    return NextResponse.redirect(new URL('/', req.url));
  }
  if (!sid && onProtected) {
    return NextResponse.redirect(new URL('/login', req.url));
  }
  return NextResponse.next();
}

export const config = {
  matcher: ['/dashboard/:path*', '/overview/:path*', '/login', '/forgot-password/:path*'],
};
