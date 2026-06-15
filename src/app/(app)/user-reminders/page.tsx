import { redirect } from 'next/navigation';
import { getCurrentActor } from '@/lib/auth/actor';
import { hasPermission } from '@/lib/permissions/check';
import { listAssignableUsers } from '@/lib/db/users';
import { UserRemindersClient } from './user-reminders-client';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export default async function UserRemindersPage() {
  const actor = await getCurrentActor();
  if (!actor) redirect('/login');
  if (!hasPermission(actor.role, actor.permissions, 'user_reminders', 'view')) {
    redirect('/dashboard');
  }

  const canEdit = hasPermission(actor.role, actor.permissions, 'user_reminders', 'edit');

  const assigneeRows = await listAssignableUsers();
  const assignees = assigneeRows.map((u) => ({ id: u.id, name: u.full_name ?? u.username }));

  return (
    <UserRemindersClient
      canEdit={canEdit}
      currentUserId={actor.id}
      assignees={assignees}
    />
  );
}
