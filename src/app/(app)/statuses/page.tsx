import { redirect } from 'next/navigation';
import { getSession } from '@/lib/auth/session';
import { listStatusesWithCounts } from '@/lib/db/statuses';
import { StatusManagementClient } from './components/StatusManagementClient';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export default async function StatusesPage() {
  const session = await getSession();
  // Layout already redirects unauthenticated → /login. Here we add the admin gate.
  if (!session) redirect('/login');
  if (!session.user.is_admin) redirect('/dashboard');

  const initialStatuses = await listStatusesWithCounts(true);
  return <StatusManagementClient initialStatuses={initialStatuses} />;
}
