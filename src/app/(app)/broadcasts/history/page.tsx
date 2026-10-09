import { redirect } from 'next/navigation';
import { getCurrentActor } from '@/lib/auth/actor';
import { hasPermission } from '@/lib/permissions/check';
import { BroadcastsHistoryClient } from './BroadcastsHistoryClient';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// /broadcasts/history — every broadcast of both channels, with a channel
// column and filter. whatsapp_chat:view (GET /api/whatsapp/campaigns); the
// stop action needs :edit, as everywhere.
export default async function BroadcastsHistoryPage() {
  const actor = await getCurrentActor();
  if (!actor) redirect('/login');
  if (!hasPermission(actor.role, actor.permissions, 'whatsapp_chat', 'view')) redirect('/dashboard');
  const canEdit = hasPermission(actor.role, actor.permissions, 'whatsapp_chat', 'edit');
  return <BroadcastsHistoryClient canEdit={canEdit} />;
}
