import { NextResponse } from 'next/server';
import { requireNotificationsAccess, type Actor } from '@/lib/auth/actor';
import { authErrorResponse } from '@/lib/auth/apiGuard';
import { clearAllNotifications, countUnread } from '@/lib/db/notifications';

export const runtime = 'nodejs';

// PATCH /api/notifications/clear-all — soft-clear every ACTIVE notification of
// the current user (cleared_at=now()). The rows stay in the DB for audit + dedup
// but vanish from every tab. Scoped to the caller. Never a hard delete.
export async function PATCH() {
  let actor: Actor;
  try {
    actor = await requireNotificationsAccess();
  } catch (err) {
    const r = authErrorResponse(err);
    if (r) return r;
    throw err;
  }

  const cleared = await clearAllNotifications(actor.id);
  const unreadCount = await countUnread(actor.id);
  return NextResponse.json({ ok: true, cleared, unreadCount });
}
