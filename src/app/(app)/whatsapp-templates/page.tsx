import { redirect } from 'next/navigation';
import { getCurrentActor } from '@/lib/auth/actor';
import { hasPermission } from '@/lib/permissions/check';
import { WhatsAppTemplatesClient } from './components/WhatsAppTemplatesClient';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export default async function WhatsAppTemplatesPage() {
  const actor = await getCurrentActor();
  if (!actor) redirect('/login');
  if (!hasPermission(actor.role, actor.permissions, 'whatsapp_templates', 'view')) {
    redirect('/dashboard');
  }

  return <WhatsAppTemplatesClient />;
}
