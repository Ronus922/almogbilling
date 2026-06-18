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
  const assignees = assigneeRows.map((u) => ({ id: u.id, name: u.full_name ?? u.username }));
  const suppliers = supplierRows.map((s) => ({
    id: s.id,
    display_name: s.display_name,
    phone: s.phone,
  }));

  return (
    <TasksPageClient
      initialTasks={initialTasks}
      initialKpis={kpis}
      assignees={assignees}
      suppliers={suppliers}
      canEdit={canEdit}
    />
  );
}
