import { redirect } from 'next/navigation';
import { getCurrentActor } from '@/lib/auth/actor';
import { hasPermission } from '@/lib/permissions/check';
import { AreasPageClient } from '@/components/areas/AreasPageClient';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export default async function AreasPage() {
  const actor = await getCurrentActor();
  if (!actor) redirect('/login');
  // rooms_areas is an admin-group module → super_admin + admin by default.
  if (!hasPermission(actor.role, actor.permissions, 'rooms_areas', 'view')) {
    redirect('/dashboard');
  }

  const canEdit = hasPermission(actor.role, actor.permissions, 'rooms_areas', 'edit');

  // Delete is a rooms_areas:edit mutation (no separate delete level in the matrix).
  return <AreasPageClient canEdit={canEdit} canDelete={canEdit} />;
}
