import { redirect } from 'next/navigation';
import { getCurrentActor } from '@/lib/auth/actor';
import { hasPermission } from '@/lib/permissions/check';
import { AdminPortalBlockedClient } from '@/components/portal/AdminPortalBlockedClient';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// /admin/portal-blocked — the phones the portal containment blocks, each with
// the apartments and the different names behind it, so the admin can unify a
// name on the apartment card or detach the wrong link here.
// Gate: module `portal_manage` (admin / super_admin) — the third layer on top
// of the route guard and the nav filter.
export default async function AdminPortalBlockedPage() {
  const actor = await getCurrentActor();
  if (!actor) redirect('/login');
  if (!hasPermission(actor.role, actor.permissions, 'portal_manage', 'view')) redirect('/dashboard');
  const canEdit = hasPermission(actor.role, actor.permissions, 'portal_manage', 'edit');
  return <AdminPortalBlockedClient canEdit={canEdit} />;
}
