import { redirect } from 'next/navigation';
import { getCurrentActor } from '@/lib/auth/actor';
import { hasPermission } from '@/lib/permissions/check';
import { BroadcastDetailClient } from './BroadcastDetailClient';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// /broadcasts/history/[id] — one broadcast and its delivery log, the same
// screen for WhatsApp and email. whatsapp_chat:view.
export default async function BroadcastDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const actor = await getCurrentActor();
  if (!actor) redirect('/login');
  if (!hasPermission(actor.role, actor.permissions, 'whatsapp_chat', 'view')) redirect('/dashboard');
  const canEdit = hasPermission(actor.role, actor.permissions, 'whatsapp_chat', 'edit');
  const { id } = await params;
  return <BroadcastDetailClient id={id} canEdit={canEdit} />;
}
