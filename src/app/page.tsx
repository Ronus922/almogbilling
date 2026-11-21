import { redirect } from 'next/navigation';
import { getSession, hasSessionCookie } from '@/lib/auth/session';
import { homePathFor } from '@/lib/auth/home';
import { SESSION_RESET_PATH } from '@/lib/constants';

export const runtime = 'nodejs';

export default async function RootPage() {
  const session = await getSession();
  // Role-conditional landing: viewer → /dashboard (debtors screen, their only
  // module), everyone else → /overview.
  if (session) redirect(homePathFor(session.user.role));
  // Not signed in. A cookie that names no live session is cleared on the way
  // (a page cannot modify cookies; the reset route can, and ends on /login).
  redirect((await hasSessionCookie()) ? SESSION_RESET_PATH : '/login');
}
