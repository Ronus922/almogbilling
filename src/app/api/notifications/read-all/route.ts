import { NextResponse } from 'next/server';
import { requireNotificationsAccess, type Actor } from '@/lib/auth/actor';
import { authErrorResponse } from '@/lib/auth/apiGuard';
import { markAllNotificationsRead, countUnread } from '@/lib/db/notifications';

export const runtime = 'nodejs';

// PATCH /api/notifications/read-all — mark every unread notification of the
// current user read (is_read=true, read_at=now()). Scoped to the caller.
export async function PATCH() {
  let actor: Actor;
  try {
    actor = await requireNotificationsAccess();
  } catch (err) {
    const r = authErrorResponse(err);
    if (r) return r;
    throw err;
  }

  const updated = await markAllNotificationsRead(actor.id);
  const unreadCount = await countUnread(actor.id);
  return NextResponse.json({ ok: true, updated, unreadCount });
}
