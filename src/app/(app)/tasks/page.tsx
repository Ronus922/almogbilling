import { redirect } from 'next/navigation';
import { getCurrentActor } from '@/lib/auth/actor';
import { hasPermission } from '@/lib/permissions/check';
import { listTasks, getTaskKpis } from '@/lib/db/tasks';
import { listAssignableUsers } from '@/lib/db/users';
import { listSuppliers } from '@/lib/db/suppliers';
import { TasksPageClient } from './tasks-page-client';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export default async function TasksPage() {
  const actor = await getCurrentActor();
  if (!actor) redirect('/login');
  if (!hasPermission(actor.role, actor.permissions, 'tasks', 'view')) {
    redirect('/dashboard');
  }

  const canEdit = hasPermission(actor.role, actor.permissions, 'tasks', 'edit');

  const [initialTasks, kpis, assigneeRows, supplierRows] = await Promise.all([
    listTasks({ sort: 'created_desc' }),
    getTaskKpis(),
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
    <TasksPageClient
      initialTasks={initialTasks}
      initialKpis={kpis}
      assignees={assignees}
      suppliers={suppliers}
      currentUser={currentUser}
      canEdit={canEdit}
    />
  );
}
