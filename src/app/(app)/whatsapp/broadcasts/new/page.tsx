import { redirect } from 'next/navigation';
import { getCurrentActor } from '@/lib/auth/actor';
import { hasPermission } from '@/lib/permissions/check';
import { BroadcastComposeClient } from './BroadcastComposeClient';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// /whatsapp/broadcasts/new — compose ONLY. Name, audience, template, message,
// variables, validation, recipient estimate, send, and (after launch) the active
// send status for THAT broadcast. No historical list is rendered here.
export default async function NewBroadcastPage() {
  const actor = await getCurrentActor();
  if (!actor) redirect('/login');
  // Composing/sending requires edit; a view-only user is bounced to the history.
  if (!hasPermission(actor.role, actor.permissions, 'whatsapp_chat', 'edit')) {
    redirect('/whatsapp/broadcasts');
  }
  return <BroadcastComposeClient />;
}
