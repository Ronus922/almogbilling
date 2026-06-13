import { redirect } from 'next/navigation';
import { getCurrentActor } from '@/lib/auth/actor';
import { hasPermission } from '@/lib/permissions/check';
import { listAssignableUsers } from '@/lib/db/users';
import { CalendarPageClient } from './calendar-page-client';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export default async function CalendarPage() {
  const actor = await getCurrentActor();
  if (!actor) redirect('/login');
  if (!hasPermission(actor.role, actor.permissions, 'calendar', 'view')) {
    redirect('/dashboard');
  }

  const canEdit = hasPermission(actor.role, actor.permissions, 'calendar', 'edit');

  const userRows = await listAssignableUsers();
  const owners = userRows.map((u) => ({ id: u.id, name: u.full_name ?? u.username }));

  return <CalendarPageClient canEdit={canEdit} owners={owners} currentUserId={actor.id} />;
}
