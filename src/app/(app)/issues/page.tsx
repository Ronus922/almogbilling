import { redirect } from 'next/navigation';
import { getCurrentActor } from '@/lib/auth/actor';
import { hasPermission } from '@/lib/permissions/check';
import { listIssues, getIssueKpis } from '@/lib/db/issues';
import { listAssignableUsers } from '@/lib/db/users';
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

  const [initialIssues, kpis, assigneeRows] = await Promise.all([
    listIssues({ sort: 'created_desc' }),
    getIssueKpis(),
    listAssignableUsers(),
  ]);
  const assignees = assigneeRows.map((u) => ({ id: u.id, name: u.full_name ?? u.username }));

  return (
    <IssuesPageClient
      initialIssues={initialIssues}
      initialKpis={kpis}
      assignees={assignees}
      canEdit={canEdit}
    />
  );
}
