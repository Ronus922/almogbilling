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
  // The "זהויות פורטל" section (moved from /admin/portal-blocked, 16/10/2026)
  // is gated on its own module, exactly as it was on its own route — a user
  // may hold one of these two without the other (independent matrix rows:
  // DEFAULT_MANAGER/DEFAULT_VIEWER list `contacts` and `portal_manage`
  // separately). The page admits on EITHER so neither loses the reach they
  // already had; each section still renders strictly behind its own module.
  const canManagePortalIdentities = hasPermission(actor.role, actor.permissions, 'portal_manage', 'view');
  if (!canViewContacts && !canManagePortalIdentities) redirect('/dashboard');
  const canEditPortalIdentities = hasPermission(actor.role, actor.permissions, 'portal_manage', 'edit');

  // Edit (create / update / import) is admin-only — matches the contacts API guards.
  const canEdit = actor.role === 'super_admin' || actor.role === 'admin';
  // The חניות ומחסנים section of the tenant panel writes through the parking
  // API, so it is gated on the PARKING module, not on contacts: a viewer holds
  // no parking row and never sees the section at all.
  const canViewParking = hasPermission(actor.role, actor.permissions, 'parking', 'view');
  const canEditParking = hasPermission(actor.role, actor.permissions, 'parking', 'edit');
  // Both lists are contacts-only data — skip them entirely for a
  // portal-identities-only visitor instead of loading rows they never see.
  const initialContacts = canViewContacts ? await listContacts({}) : [];
  // The Bllink queue's size, so the chip is rendered on the first paint rather
  // than appearing a moment later. Only ever shown when it is > 0.
  const pendingSuggestions = canViewContacts ? await countPendingSuggestions() : 0;

  return (
    <ContactsPageClient
      initialContacts={initialContacts}
      canViewContacts={canViewContacts}
      canEdit={canEdit}
      canViewParking={canViewParking}
      canEditParking={canEditParking}
      pendingSuggestions={pendingSuggestions}
      canManagePortalIdentities={canManagePortalIdentities}
      canEditPortalIdentities={canEditPortalIdentities}
    />
  );
}
