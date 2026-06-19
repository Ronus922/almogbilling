import { redirect } from 'next/navigation';
import { getCurrentActor } from '@/lib/auth/actor';
import { listNotificationsPage } from '@/lib/db/notifications';
import { NotificationsPageClient } from './notifications-page-client';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const PAGE_SIZE = 20;

// /notifications — every authenticated user's personal notification stream.
// Personal infrastructure: NOT a RBAC module (no permission gate) — each user
// sees only their own rows (scoped server-side by actor.id). Entry is via the
// bell's "צפה בכל ההתראות" footer link. The read-only `viewer` is the one
// exception: scoped to the debtors screen only → no notifications (bell hidden +
// /api/notifications/* deny viewer), so this page redirects them away.
export default async function NotificationsPage() {
  const actor = await getCurrentActor();
  if (!actor) redirect('/login');
  if (actor.role === 'viewer') redirect('/dashboard');

  const { items, total } = await listNotificationsPage(actor.id, { page: 1, pageSize: PAGE_SIZE });

  return (
    <NotificationsPageClient
      initialItems={items}
      initialTotal={total}
      pageSize={PAGE_SIZE}
    />
  );
}
