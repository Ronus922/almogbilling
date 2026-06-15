import { redirect } from 'next/navigation';
import { getCurrentActor } from '@/lib/auth/actor';
import { hasPermission } from '@/lib/permissions/check';
import { DocumentsPageClient } from '@/components/documents/DocumentsPageClient';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export default async function DocumentsPage() {
  const actor = await getCurrentActor();
  if (!actor) redirect('/login');
  if (!hasPermission(actor.role, actor.permissions, 'documents', 'view')) {
    redirect('/dashboard');
  }

  const canEdit = hasPermission(actor.role, actor.permissions, 'documents', 'edit');

  return <DocumentsPageClient canEdit={canEdit} />;
}
