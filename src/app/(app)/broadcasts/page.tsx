import { redirect } from 'next/navigation';
import { getCurrentActor } from '@/lib/auth/actor';
import { hasPermission } from '@/lib/permissions/check';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// /broadcasts — the "תפוצה" category's entry: whoever may send lands on a new
// broadcast, whoever may only look lands on the history. Same permission as
// every broadcast screen and route: whatsapp_chat (view / edit).
export default async function BroadcastsPage() {
  const actor = await getCurrentActor();
  if (!actor) redirect('/login');
  if (hasPermission(actor.role, actor.permissions, 'whatsapp_chat', 'edit')) redirect('/broadcasts/new');
  if (hasPermission(actor.role, actor.permissions, 'whatsapp_chat', 'view')) redirect('/broadcasts/history');
  redirect('/dashboard');
}
