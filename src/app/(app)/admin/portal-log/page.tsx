import { Suspense } from 'react';
import { redirect } from 'next/navigation';
import { getCurrentActor } from '@/lib/auth/actor';
import { hasPermission } from '@/lib/permissions/check';
import { AdminPortalLogClient } from '@/components/portal/AdminPortalLogClient';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// /admin/portal-log — the full owners-portal login log. Inside the (app) group on
// purpose: it is a STAFF screen and gets the app shell, the nav and the same
// session/permission gating as every other admin page.
// Gate: module `portal_manage` (admin / super_admin), the third layer on top of
// the route guard and the nav filter.
export default async function AdminPortalLogPage() {
  const actor = await getCurrentActor();
  if (!actor) redirect('/login');
  if (!hasPermission(actor.role, actor.permissions, 'portal_manage', 'view')) redirect('/dashboard');

  return (
    <Suspense fallback={<div className="h-64 animate-pulse rounded-xl bg-muted/60" />}>
      <AdminPortalLogClient />
    </Suspense>
  );
}
