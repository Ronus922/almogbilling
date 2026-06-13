import { redirect } from 'next/navigation';
import { getCurrentActor } from '@/lib/auth/actor';
import { hasPermission } from '@/lib/permissions/check';
import { listContacts } from '@/lib/db/contacts';
import { ContactsPageClient } from './contacts-page-client';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export default async function ContactsPage() {
  const actor = await getCurrentActor();
  if (!actor) redirect('/login');
  if (!hasPermission(actor.role, actor.permissions, 'contacts', 'view')) {
    redirect('/dashboard');
  }

  // Edit (create / update / import) is admin-only — matches the contacts API guards.
  const canEdit = actor.role === 'super_admin' || actor.role === 'admin';
  const initialContacts = await listContacts({});

  return <ContactsPageClient initialContacts={initialContacts} canEdit={canEdit} />;
}
