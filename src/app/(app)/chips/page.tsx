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
  // Chip orders (12/11/2026) — the "הזמנות" view, admin / super admin by default.
  const canManageOrders = hasPermission(actor.role, actor.permissions, 'chips_orders_manage', 'view');
  const canEditOrders = hasPermission(actor.role, actor.permissions, 'chips_orders_manage', 'edit');

  const canWriteContacts = hasPermission(actor.role, actor.permissions, 'contacts', 'edit');

  return (
    <ChipsPageClient
      canEdit={canEdit}
      canManageOrders={canManageOrders}
      canEditOrders={canEditOrders}
      canWriteContacts={canWriteContacts}
    />
  );
}
