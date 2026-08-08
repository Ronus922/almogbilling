import { redirect } from 'next/navigation';
import { getCurrentActor } from '@/lib/auth/actor';
import { hasPermission } from '@/lib/permissions/check';
import { ChipsPageClient } from '@/components/chips/ChipsPageClient';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export default async function ChipsPage() {
  const actor = await getCurrentActor();
  if (!actor) redirect('/login');
  if (!hasPermission(actor.role, actor.permissions, 'chips', 'view')) {
    redirect('/dashboard');
  }

  const canEdit = hasPermission(actor.role, actor.permissions, 'chips', 'edit');

  return <ChipsPageClient canEdit={canEdit} />;
}
