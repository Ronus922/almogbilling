import { redirect } from 'next/navigation';
import { getCurrentActor } from '@/lib/auth/actor';
import { hasPermission } from '@/lib/permissions/check';
import { SuppliersPageClient } from '@/components/suppliers/SuppliersPageClient';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export default async function SuppliersPage() {
  const actor = await getCurrentActor();
  if (!actor) redirect('/login');
  if (!hasPermission(actor.role, actor.permissions, 'suppliers', 'view')) {
    redirect('/dashboard');
  }

  const canEdit = hasPermission(actor.role, actor.permissions, 'suppliers', 'edit');
  const isAdmin = actor.role === 'super_admin' || actor.role === 'admin';

  return <SuppliersPageClient canEdit={canEdit} canDelete={isAdmin} />;
}
