import { redirect } from 'next/navigation';
import { getCurrentActor } from '@/lib/auth/actor';
import { hasPermission } from '@/lib/permissions/check';
import { isWorkerRole } from '@/lib/permissions/constants';
import { listTasks, listRecurringSeries } from '@/lib/db/tasks';
import { listAssignableUsers } from '@/lib/db/users';
import { listSuppliers } from '@/lib/db/suppliers';
import { listWorkItems, getWorkItemKpis } from '@/lib/db/workItems';
import { WorkerTasksSection } from '@/components/tasks/worker-tasks-section';
import { WorkEntityScreen } from '@/components/work-items/WorkEntityScreen';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// משימות — the second of two separate screens (12/10/2026, Decisions Log:
// "עיצוב משותף, ישויות נפרדות" cancels the 11/10/2026 unified /work screen).
// Same design as /issues (WorkEntityScreen, shared library), own nav item,
// own data — this route never reads the issues table. Adds a field-worker
// branch that did not exist on this route before 11/10/2026 (workers had no
// scoped tasks view until the unified module introduced WorkerTasksSection —
// preserved here now that /tasks is a real nav destination again).
export default async function TasksPage() {
  const actor = await getCurrentActor();
  if (!actor) redirect('/login');
  if (!hasPermission(actor.role, actor.permissions, 'tasks', 'view')) {
    redirect('/dashboard');
  }

  if (isWorkerRole(actor.role)) {
    const mine = await listTasks({ assignedTo: actor.id, sort: 'created_desc' });
    return <WorkerTasksSection tasks={mine} />;
  }

  const canEdit = hasPermission(actor.role, actor.permissions, 'tasks', 'edit');

  // No pre-generation step: a recurring task is a single row whose due_date is
  // its current occurrence (migration 067), so listing is a pure read.
  const [initialItems, kpis, assigneeRows, supplierRows, initialSeries] = await Promise.all([
    listWorkItems('task', { tab: 'active' }, actor),
    getWorkItemKpis('task', actor),
    listAssignableUsers(),
    listSuppliers({}),
    listRecurringSeries(),
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
      kind="task"
      initialItems={initialItems}
      initialKpis={kpis}
      initialSeries={initialSeries}
      assignees={assignees}
      suppliers={suppliers}
      currentUser={currentUser}
      canEdit={canEdit}
    />
  );
}
