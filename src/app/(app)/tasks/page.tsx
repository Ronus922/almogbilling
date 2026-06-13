import { redirect } from 'next/navigation';
import { getCurrentActor } from '@/lib/auth/actor';
import { hasPermission } from '@/lib/permissions/check';
import { listTasks, getTaskKpis } from '@/lib/db/tasks';
import { listAssignableUsers } from '@/lib/db/users';
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

  const [initialTasks, kpis, assigneeRows] = await Promise.all([
    listTasks({ sort: 'created_desc' }),
    getTaskKpis(),
    listAssignableUsers(),
  ]);
  const assignees = assigneeRows.map((u) => ({ id: u.id, name: u.full_name ?? u.username }));

  return (
    <TasksPageClient
      initialTasks={initialTasks}
      initialKpis={kpis}
      assignees={assignees}
      canEdit={canEdit}
    />
  );
}
