import { redirect } from 'next/navigation';
import { getCurrentActor } from '@/lib/auth/actor';
import { hasPermission } from '@/lib/permissions/check';
import { isWorkerRole, roleLabel } from '@/lib/permissions/constants';
import { listIssues, getIssueKpis } from '@/lib/db/issues';
import { listAssignableUsers, findUserById } from '@/lib/db/users';
import { listSuppliers } from '@/lib/db/suppliers';
import { IssuesPageClient } from './issues-page-client';
import { WorkerIssuesView } from '@/components/issues/worker-issues-view';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export default async function IssuesPage() {
  const actor = await getCurrentActor();
  if (!actor) redirect('/login');
  if (!hasPermission(actor.role, actor.permissions, 'issues', 'view')) {
    redirect('/dashboard');
  }

  // ── Field worker: a different screen entirely ───────────────────────────────
  // Branch BEFORE the manager-path loads below, not after. A worker holds no
  // `suppliers` and no `users_management` permission, so their page must never
  // fetch the supplier roster or the full user list — server-side branching is
  // what keeps that data out of their RSC payload in the first place.
  //
  // `?assignedTo=` is a FILTER, not a security boundary (any issues:view holder
  // can ask for anyone's list via the API). Scoping here is about giving the
  // worker the right screen, not about isolation — say so plainly rather than
  // implying an isolation this route does not enforce.
  if (isWorkerRole(actor.role)) {
    const [mine, me] = await Promise.all([
      listIssues({ assignedTo: actor.id, sort: 'created_desc' }),
      findUserById(actor.id),
    ]);
    return (
      <WorkerIssuesView
        issues={mine}
        userName={actor.full_name ?? actor.username}
        roleName={roleLabel(actor.role)}
        todayLabel={new Date().toLocaleDateString('he-IL', {
          weekday: 'long', day: 'numeric', month: 'long', year: 'numeric',
          timeZone: 'Asia/Jerusalem',
        })}
        currentUser={{
          id: actor.id,
          name: actor.full_name ?? actor.username,
          hasEmail: !!(me?.email ?? actor.email),
          hasPhone: !!me?.notification_phone,
        }}
      />
    );
  }

  // ── Manager / admin: the existing screen, unchanged ─────────────────────────
  const canEdit = hasPermission(actor.role, actor.permissions, 'issues', 'edit');

  const [initialIssues, kpis, assigneeRows, supplierRows] = await Promise.all([
    listIssues({ sort: 'created_desc' }),
    getIssueKpis(),
    listAssignableUsers(),
    listSuppliers({}), // reuse the existing suppliers DB layer for the picker/filter
  ]);
  const assignees = assigneeRows.map((u) => ({
    id: u.id,
    name: u.full_name ?? u.username,
    hasEmail: !!u.email,
    hasPhone: !!u.notification_phone,
  }));
  const suppliers = supplierRows.map((s) => ({
    id: s.id,
    display_name: s.display_name,
    phone: s.phone,
    mobile: s.mobile,
    email: s.email,
  }));

  // Contact-detail availability for "אליי" in the notification matrix.
  const meRow = assigneeRows.find((u) => u.id === actor.id);
  const currentUser = {
    id: actor.id,
    name: actor.full_name ?? actor.username,
    hasEmail: meRow ? !!meRow.email : !!actor.email,
    hasPhone: meRow ? !!meRow.notification_phone : false,
  };

  return (
    <IssuesPageClient
      initialIssues={initialIssues}
      initialKpis={kpis}
      assignees={assignees}
      suppliers={suppliers}
      currentUser={currentUser}
      canEdit={canEdit}
    />
  );
}
