import 'server-only';
import { redirect } from 'next/navigation';
import { getSession } from './session';
import { homePathFor } from './home';

/**
 * The auth pages (/login, /forgot-password) send a visitor who is REALLY
 * signed in to their role's home (21/11/2026). The session is validated here,
 * against the DB — a cookie alone proves nothing. A dead cookie (expired,
 * deleted, its user disabled) falls through and the page renders its form, so
 * the auth pages can never take part in a redirect loop; the next successful
 * login overwrites that cookie.
 */
export async function redirectIfSignedIn(): Promise<void> {
  const session = await getSession();
  if (session) redirect(homePathFor(session.user.role));
}
