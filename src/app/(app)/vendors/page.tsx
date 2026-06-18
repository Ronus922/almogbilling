import { redirect } from 'next/navigation';
import { getCurrentActor } from '@/lib/auth/actor';
import { hasPermission } from '@/lib/permissions/check';
import { VendorsPageClient } from '@/components/vendors/VendorsPageClient';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// /vendors — the service-provider directory (gated on the vendors module).
export default async function VendorsPage() {
  const actor = await getCurrentActor();
  if (!actor) redirect('/login');
  if (!hasPermission(actor.role, actor.permissions, 'vendors', 'view')) {
    redirect('/dashboard');
  }

  const canEdit = hasPermission(actor.role, actor.permissions, 'vendors', 'edit');

  // Delete is a vendors:edit mutation (no separate delete level in the matrix).
  return <VendorsPageClient canEdit={canEdit} />;
}
