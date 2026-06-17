import { redirect } from 'next/navigation';
import { getCurrentActor } from '@/lib/auth/actor';
import { listUsers, listOpenInvites } from '@/lib/db/users';
import { UsersClient } from '@/components/settings/users/UsersClient';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export default async function UsersSettingsPage() {
  const actor = await getCurrentActor();
  if (!actor) redirect('/login');
  // Page is open to admin + super_admin. Per-action authority (who may touch
  // whom) is enforced both in the UI (UsersClient) and server-side in the
  // /api/users routes.
  if (actor.role !== 'super_admin' && actor.role !== 'admin') redirect('/dashboard');

  const [users, invites] = await Promise.all([listUsers(), listOpenInvites()]);

  return (
    <div className="mx-auto max-w-6xl space-y-6 p-6">
      <UsersClient
        initialUsers={users}
        initialInvites={invites}
        currentUserId={actor.id}
        currentUserRole={actor.role}
      />
    </div>
  );
}
