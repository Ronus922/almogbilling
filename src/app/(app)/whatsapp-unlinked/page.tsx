import { redirect } from 'next/navigation';
import { getCurrentActor } from '@/lib/auth/actor';
import { hasPermission } from '@/lib/permissions/check';
import { WhatsAppUnlinkedClient } from './components/WhatsAppUnlinkedClient';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export default async function WhatsAppUnlinkedPage() {
  const actor = await getCurrentActor();
  if (!actor) redirect('/login');
  if (!hasPermission(actor.role, actor.permissions, 'whatsapp', 'view')) {
    redirect('/dashboard');
  }
  const canLink = hasPermission(actor.role, actor.permissions, 'whatsapp', 'edit');

  return <WhatsAppUnlinkedClient canLink={canLink} />;
}
