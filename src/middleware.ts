import { NextResponse, type NextRequest } from 'next/server';
import { SESSION_COOKIE } from '@/lib/constants';

const AUTH_PAGES = ['/login', '/forgot-password'];
const PROTECTED = ['/dashboard'];

export function middleware(req: NextRequest) {
  const sid = req.cookies.get(SESSION_COOKIE)?.value;
  const { pathname } = req.nextUrl;

  const onAuth = AUTH_PAGES.some((p) => pathname === p || pathname.startsWith(p + '/'));
  const onProtected = PROTECTED.some((p) => pathname === p || pathname.startsWith(p + '/'));

  if (sid && onAuth) {
    return NextResponse.redirect(new URL('/dashboard', req.url));
  }
  if (!sid && onProtected) {
    return NextResponse.redirect(new URL('/login', req.url));
  }
  return NextResponse.next();
}

export const config = {
  matcher: ['/dashboard/:path*', '/login', '/forgot-password/:path*'],
};
