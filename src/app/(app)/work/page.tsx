import { redirect } from 'next/navigation';
import { getCurrentActor } from '@/lib/auth/actor';
import { canSeeReporterPhone, hasPermission } from '@/lib/permissions/check';
import { isWorkerRole } from '@/lib/permissions/constants';
import { listIssues } from '@/lib/db/issues';
import { listTasks } from '@/lib/db/tasks';
import { listAssignableUsers, findUserById } from '@/lib/db/users';
import { listSuppliers } from '@/lib/db/suppliers';
import { listWorkItems, getWorkItemKpis } from '@/lib/db/workItems';
import { WorkerIssuesView } from '@/components/issues/worker-issues-view';
import { WorkerTasksSection } from '@/components/tasks/worker-tasks-section';
import { WorkPageClient } from './work-page-client';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// Unified "תקלות ומשימות" screen (11/10/2026) — replaces the two separate
// /issues + /tasks screens in the nav (both routes stay, as redirects — see
// their page.tsx). See Decisions Log 11/10/2026 for the full visibility model.
export default async function WorkPage() {
  const actor = await getCurrentActor();
  if (!actor) redirect('/login');
  const canViewIssues = hasPermission(actor.role, actor.permissions, 'issues', 'view');
  const canViewTasks = hasPermission(actor.role, actor.permissions, 'tasks', 'view');
  if (!canViewIssues && !canViewTasks) redirect('/dashboard');

  // ── Field worker: the existing mobile-first view, preserved unchanged for
  // issues, with a tasks section of the same shape added below it (tasks had
  // NO scoped worker view before this module — see Decisions Log). ──────────
  if (isWorkerRole(actor.role)) {
    const [myIssues, myTasks, me] = await Promise.all([
      canViewIssues ? listIssues({ assignedTo: actor.id, sort: 'created_desc' }) : Promise.resolve([]),
      canViewTasks ? listTasks({ assignedTo: actor.id, sort: 'created_desc' }) : Promise.resolve([]),
      findUserById(actor.id),
    ]);
    return (
      <div className="space-y-8">
        {canViewIssues && (
          <WorkerIssuesView
            issues={myIssues}
            userName={actor.full_name ?? actor.username}
            roleName={actor.role === 'cleaner' ? 'עובד ניקיון' : 'עובד אחזקה'}
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
        )}
        {canViewTasks && <WorkerTasksSection tasks={myTasks} />}
      </div>
    );
  }

  // ── Manager / admin / super_admin / viewer: the unified list + board ──────
  const canEditIssues = hasPermission(actor.role, actor.permissions, 'issues', 'edit');
  const canEditTasks = hasPermission(actor.role, actor.permissions, 'tasks', 'edit');

  const [initialItems, kpis, assigneeRows, supplierRows] = await Promise.all([
    listWorkItems({ tab: 'active' }, actor),
    getWorkItemKpis(actor),
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
    <WorkPageClient
      initialItems={initialItems}
      initialKpis={kpis}
      assignees={assignees}
      suppliers={suppliers}
      currentUser={currentUser}
      canEditIssues={canEditIssues}
      canEditTasks={canEditTasks}
      canViewIssues={canViewIssues}
      canViewTasks={canViewTasks}
      canSeeReporterPhone={canSeeReporterPhone(actor.role, actor.permissions)}
    />
  );
}
