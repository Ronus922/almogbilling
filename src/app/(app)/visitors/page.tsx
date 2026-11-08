import { redirect } from 'next/navigation';
import { getCurrentActor } from '@/lib/auth/actor';
import { homePathFor } from '@/lib/auth/home';
import { canCreateVisitorScan, canEditVisitorNotes, canManageVisitorScans, canViewVisitors } from '@/lib/permissions/check';
import { isGuardRole } from '@/lib/permissions/constants';
import { VisitorsClient } from '@/components/visitors/VisitorsClient';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// /visitors — "סריקת כניסה" (08/11/2026). The guard's only screen, and a log every
// role may read (VISITOR_VIEW_ROLES). What a viewer may DO is a role question the
// server re-asks on every route; the flags below only decide what the screen shows.
export default async function VisitorsPage() {
  const actor = await getCurrentActor();
  if (!actor) redirect('/login');
  if (!canViewVisitors(actor.role)) redirect(homePathFor(actor.role));

  return (
    <VisitorsClient
      caps={{
        canScan: canCreateVisitorScan(actor.role),
        canEditNotes: canEditVisitorNotes(actor.role),
        canManage: canManageVisitorScans(actor.role),
        isGuard: isGuardRole(actor.role),
      }}
    />
  );
}
