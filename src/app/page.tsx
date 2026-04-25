import { redirect } from 'next/navigation';
import { getSession } from '@/lib/auth/session';

export const runtime = 'nodejs';

export default async function RootPage() {
  const session = await getSession();
  redirect(session ? '/dashboard' : '/login');
}
