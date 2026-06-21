import { redirect } from 'next/navigation';
import { getSession } from '@/lib/auth/session';
import { homePathFor } from '@/lib/auth/home';

export const runtime = 'nodejs';

export default async function RootPage() {
  const session = await getSession();
  // Role-conditional landing: viewer → /dashboard (debtors screen, their only
  // module), everyone else → /overview. Unauthenticated → /login.
  redirect(session ? homePathFor(session.user.role) : '/login');
}
