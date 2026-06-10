import { redirect } from 'next/navigation';
import { getCurrentActor } from '@/lib/auth/actor';
import { hasPermission } from '@/lib/permissions/check';
import { listStatusesWithCounts } from '@/lib/db/statuses';
import { StatusManagementClient } from './components/StatusManagementClient';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export default async function StatusesPage() {
  const actor = await getCurrentActor();
  if (!actor) redirect('/login');
  if (!hasPermission(actor.role, actor.permissions, 'status_management', 'view')) {
    redirect('/dashboard');
  }

  const initialStatuses = await listStatusesWithCounts(true);
  return <StatusManagementClient initialStatuses={initialStatuses} />;
}
