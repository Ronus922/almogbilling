import { redirect } from 'next/navigation';
import { getCurrentActor } from '@/lib/auth/actor';
import { hasPermission } from '@/lib/permissions/check';
import { listIssues, getIssueKpis } from '@/lib/db/issues';
import { listAssignableUsers } from '@/lib/db/users';
import { listSuppliers } from '@/lib/db/suppliers';
import { IssuesPageClient } from './issues-page-client';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export default async function IssuesPage() {
  const actor = await getCurrentActor();
  if (!actor) redirect('/login');
  if (!hasPermission(actor.role, actor.permissions, 'issues', 'view')) {
    redirect('/dashboard');
  }

  const canEdit = hasPermission(actor.role, actor.permissions, 'issues', 'edit');

  const [initialIssues, kpis, assigneeRows, supplierRows] = await Promise.all([
    listIssues({ sort: 'created_desc' }),
    getIssueKpis(),
    listAssignableUsers(),
    listSuppliers({}), // reuse the existing suppliers DB layer for the picker/filter
  ]);
  const assignees = assigneeRows.map((u) => ({ id: u.id, name: u.full_name ?? u.username }));
  const suppliers = supplierRows.map((s) => ({
    id: s.id,
    display_name: s.display_name,
    phone: s.phone,
  }));

  return (
    <IssuesPageClient
      initialIssues={initialIssues}
      initialKpis={kpis}
      assignees={assignees}
      suppliers={suppliers}
      canEdit={canEdit}
    />
  );
}
