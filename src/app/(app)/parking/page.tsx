import { redirect } from 'next/navigation';
import { getCurrentActor } from '@/lib/auth/actor';
import { hasPermission } from '@/lib/permissions/check';
import { ParkingPageClient } from '@/components/parking/ParkingPageClient';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

interface PageProps {
  searchParams: Promise<{ apartment?: string }>;
}

export default async function ParkingPage({ searchParams }: PageProps) {
  const actor = await getCurrentActor();
  if (!actor) redirect('/login');

  // RBAC layer 3a. viewer / cleaner / maintenance hold no 'parking' row, so
  // hasPermission fails closed and they never reach the screen — matching the
  // nav, which hides the item for exactly the same reason.
  if (!hasPermission(actor.role, actor.permissions, 'parking', 'view')) {
    redirect('/dashboard');
  }

  const canEdit = hasPermission(actor.role, actor.permissions, 'parking', 'edit');
  // Excel import is admin-only (see the import route's requireAdmin guard) —
  // the button is hidden for everyone else rather than shown and rejected.
  const canImport = actor.role === 'super_admin' || actor.role === 'admin';

  // /parking?apartment=1234 — deep link from the contacts panel.
  const { apartment } = await searchParams;

  return (
    <ParkingPageClient
      canEdit={canEdit}
      canImport={canImport}
      initialApartment={apartment?.trim() || null}
    />
  );
}
