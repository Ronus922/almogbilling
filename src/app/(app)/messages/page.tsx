import { redirect } from 'next/navigation';
import { getCurrentActor } from '@/lib/auth/actor';
import { hasPermission } from '@/lib/permissions/check';
import { MessagesClient } from './components/MessagesClient';

export const runtime = 'nodejs';

// /messages — the WhatsApp conversational inbox (gated on the whatsapp_chat module).
export default async function MessagesPage() {
  const actor = await getCurrentActor();
  if (!actor) redirect('/login');
  if (!hasPermission(actor.role, actor.permissions, 'whatsapp_chat', 'view')) {
    redirect('/dashboard');
  }

  const canEdit = hasPermission(actor.role, actor.permissions, 'whatsapp_chat', 'edit');
  const canManageTemplates = hasPermission(actor.role, actor.permissions, 'whatsapp_templates', 'edit');
  const isAdmin = actor.role === 'admin' || actor.role === 'super_admin';

  return (
    <MessagesClient
      canEdit={canEdit}
      canManageTemplates={canManageTemplates}
      isAdmin={isAdmin}
      currentUserId={actor.id}
    />
  );
}
