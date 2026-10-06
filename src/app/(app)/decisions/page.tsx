import { redirect } from 'next/navigation';
import { getCurrentActor } from '@/lib/auth/actor';
import { hasPermission } from '@/lib/permissions/check';
import { listDecisions } from '@/lib/db/portalDecisions';
import { toDecisionAdminView } from '@/lib/decisionsView';
import { DecisionsClient } from '@/components/decisions/DecisionsClient';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// /decisions — the decisions and protocols the owners portal publishes: upload
// a PDF, edit its metadata, show or hide it, delete it.
// Gate: module `portal_decisions` (admin / super_admin) — the third layer on
// top of the route guards and the nav filter, exactly like /finance.
export default async function DecisionsPage() {
  const actor = await getCurrentActor();
  if (!actor) redirect('/login');
  if (!hasPermission(actor.role, actor.permissions, 'portal_decisions', 'view')) redirect('/dashboard');
  const canEdit = hasPermission(actor.role, actor.permissions, 'portal_decisions', 'edit');
  const decisions = (await listDecisions()).map(toDecisionAdminView);
  return <DecisionsClient initial={decisions} canEdit={canEdit} />;
}
