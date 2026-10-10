import { redirect } from 'next/navigation';
import { getCurrentActor } from '@/lib/auth/actor';
import { hasPermission } from '@/lib/permissions/check';
import { BroadcastComposeClient } from './BroadcastComposeClient';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// /broadcasts/new — "תפוצה חדשה": the compose form with the channel selector
// (WhatsApp / email). Sending = whatsapp_chat:edit, the same gate as
// POST /api/whatsapp/campaigns; a viewer of broadcasts goes to the history.
export default async function NewBroadcastPage() {
  const actor = await getCurrentActor();
  if (!actor) redirect('/login');
  if (!hasPermission(actor.role, actor.permissions, 'whatsapp_chat', 'edit')) {
    redirect(hasPermission(actor.role, actor.permissions, 'whatsapp_chat', 'view') ? '/broadcasts/history' : '/dashboard');
  }
  return <BroadcastComposeClient />;
}
