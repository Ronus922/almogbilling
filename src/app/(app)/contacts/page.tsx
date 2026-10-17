import { redirect } from 'next/navigation';
import { getCurrentActor } from '@/lib/auth/actor';
import { hasPermission } from '@/lib/permissions/check';
import { listContacts } from '@/lib/db/contacts';
import { countPendingSuggestions } from '@/lib/db/contactSuggestions';
import { ContactsPageClient } from './contacts-page-client';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export default async function ContactsPage() {
  const actor = await getCurrentActor();
  if (!actor) redirect('/login');
  const canViewContacts = hasPermission(actor.role, actor.permissions, 'contacts', 'view');
  if (!canViewContacts) redirect('/dashboard');

  // Edit (create / update / import) is admin-only — matches the contacts API guards.
  const canEdit = actor.role === 'super_admin' || actor.role === 'admin';
  // The חניות ומחסנים section of the tenant panel writes through the parking
  // API, so it is gated on the PARKING module, not on contacts: a viewer holds
  // no parking row and never sees the section at all.
  const canViewParking = hasPermission(actor.role, actor.permissions, 'parking', 'view');
  const canEditParking = hasPermission(actor.role, actor.permissions, 'parking', 'edit');
  const initialContacts = await listContacts({});
  // The Bllink queue's size, so the chip is rendered on the first paint rather
  // than appearing a moment later. Only ever shown when it is > 0.
  const pendingSuggestions = await countPendingSuggestions();

  return (
    <ContactsPageClient
      initialContacts={initialContacts}
      canViewContacts={canViewContacts}
      canEdit={canEdit}
      canViewParking={canViewParking}
      canEditParking={canEditParking}
      pendingSuggestions={pendingSuggestions}
    />
  );
}
