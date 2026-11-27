import { redirect } from 'next/navigation';
import { getCurrentActor } from '@/lib/auth/actor';
import { hasPermission } from '@/lib/permissions/check';
import { isElevatedRole } from '@/lib/permissions/constants';
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
  // "בטל הזמנת קבלה", "זיכוי" (26/11/2026) and "הפק חשבונית שוב" — admin and
  // super admin, by ROLE (each route asks again: requireAdmin). A manager who
  // may record a payment may not undo or refund it.
  const canAdminOrders = isElevatedRole(actor.role);
  // "סגירה ידנית" of a stuck "ביטול וזיכוי" (27/11/2026) — super admin only,
  // by role (the route asks again).
  const canCloseByHand = actor.role === 'super_admin';

  return (
    <ChipsPageClient
      canEdit={canEdit}
      canManageOrders={canManageOrders}
      canEditOrders={canEditOrders}
      canWriteContacts={canWriteContacts}
      canAdminOrders={canAdminOrders}
      canCloseByHand={canCloseByHand}
    />
  );
}
