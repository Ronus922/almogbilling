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
  // The חניות ומחסנים section of the tenant panel writes through the parking
  // API, so it is gated on the PARKING module, not on contacts: a viewer holds
  // no parking row and never sees the section at all.
  const canViewParking = hasPermission(actor.role, actor.permissions, 'parking', 'view');
  const canEditParking = hasPermission(actor.role, actor.permissions, 'parking', 'edit');
  const initialContacts = await listContacts({});

  return (
    <ContactsPageClient
      initialContacts={initialContacts}
      canEdit={canEdit}
      canViewParking={canViewParking}
      canEditParking={canEditParking}
    />
  );
}
