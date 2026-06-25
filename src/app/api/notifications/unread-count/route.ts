import { NextResponse } from 'next/server';
import { requireNotificationsAccess, type Actor } from '@/lib/auth/actor';
import { authErrorResponse } from '@/lib/auth/apiGuard';
import { countUnreadSplit } from '@/lib/db/notifications';

export const runtime = 'nodejs';

// GET /api/notifications/unread-count → { count, whatsappCount } — the lightweight
// 60s poll target for BOTH header badges in one round-trip. `count` is the bell
// badge (every active unread EXCEPT WhatsApp); `whatsappCount` is the dedicated
// WhatsApp dropdown badge. Disjoint by construction → no double-count. Scoped to
// the current user.
export async function GET() {
  let actor: Actor;
  try {
    actor = await requireNotificationsAccess();
  } catch (err) {
    const r = authErrorResponse(err);
    if (r) return r;
    throw err;
  }

  const { bell, whatsapp } = await countUnreadSplit(actor.id);
  return NextResponse.json({ count: bell, whatsappCount: whatsapp });
}
