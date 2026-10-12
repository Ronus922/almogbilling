import { redirect } from 'next/navigation';
import { getCurrentActor } from '@/lib/auth/actor';
import { canSeeReporterPhone, hasPermission } from '@/lib/permissions/check';
import { isWorkerRole, roleLabel } from '@/lib/permissions/constants';
import { listIssues } from '@/lib/db/issues';
import { listAssignableUsers, findUserById } from '@/lib/db/users';
import { listSuppliers } from '@/lib/db/suppliers';
import { listWorkItems, getWorkItemKpis } from '@/lib/db/workItems';
import { WorkerIssuesView } from '@/components/issues/worker-issues-view';
import { WorkEntityScreen } from '@/components/work-items/WorkEntityScreen';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// תקלות — one of two separate screens (12/10/2026, Decisions Log: "עיצוב
// משותף, ישויות נפרדות" cancels the 11/10/2026 unified /work screen). Same
// design as /tasks (WorkEntityScreen, shared library), own nav item, own
// data — this route never reads the tasks table.
export default async function IssuesPage() {
  const actor = await getCurrentActor();
  if (!actor) redirect('/login');
  if (!hasPermission(actor.role, actor.permissions, 'issues', 'view')) {
    redirect('/dashboard');
  }

  // ── Field worker: the existing mobile-first view, preserved unchanged ────
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

  // ── Manager / admin / super_admin / viewer: the board/list screen ────────
  const canEdit = hasPermission(actor.role, actor.permissions, 'issues', 'edit');
  const reporterPhoneVisible = canSeeReporterPhone(actor.role, actor.permissions);

  const [initialItems, kpis, assigneeRows, supplierRows] = await Promise.all([
    listWorkItems('issue', { tab: 'active' }, actor),
    getWorkItemKpis('issue', actor),
    listAssignableUsers(),
    listSuppliers({}),
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

  const meRow = assigneeRows.find((u) => u.id === actor.id);
  const currentUser = {
    id: actor.id,
    name: actor.full_name ?? actor.username,
    hasEmail: meRow ? !!meRow.email : !!actor.email,
    hasPhone: meRow ? !!meRow.notification_phone : false,
  };

  return (
    <WorkEntityScreen
      kind="issue"
      initialItems={initialItems}
      initialKpis={kpis}
      assignees={assignees}
      suppliers={suppliers}
      currentUser={currentUser}
      canEdit={canEdit}
      canSeeReporterPhone={reporterPhoneVisible}
    />
  );
}
