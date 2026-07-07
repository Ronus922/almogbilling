import { redirect } from 'next/navigation';
import { getCurrentActor } from '@/lib/auth/actor';
import { hasPermission } from '@/lib/permissions/check';
import { BroadcastsHistoryClient } from './BroadcastsHistoryClient';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// /whatsapp/broadcasts — the scalable broadcast HISTORY. The compose form lives at
// /whatsapp/broadcasts/new, so history is never rendered under the form.
export default async function BroadcastsPage() {
  const actor = await getCurrentActor();
  if (!actor) redirect('/login');
  if (!hasPermission(actor.role, actor.permissions, 'whatsapp_chat', 'view')) redirect('/dashboard');
  const canEdit = hasPermission(actor.role, actor.permissions, 'whatsapp_chat', 'edit');
  return <BroadcastsHistoryClient canEdit={canEdit} />;
}
