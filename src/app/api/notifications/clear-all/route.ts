import { NextResponse } from 'next/server';
import { requireNotificationsAccess, type Actor } from '@/lib/auth/actor';
import { authErrorResponse } from '@/lib/auth/apiGuard';
import { clearAllNotifications, countUnreadSplit } from '@/lib/db/notifications';
import { surfaceScope } from '../surface';

export const runtime = 'nodejs';

// PATCH /api/notifications/clear-all[?surface=bell|whatsapp|internal_chat] —
// soft-clear ACTIVE notifications (cleared_at=now()). Rows stay in the DB for
// audit + dedup but vanish from every tab. `?surface=bell` excludes the dedicated
// modules; `?surface=whatsapp` / `?surface=internal_chat` are that module only;
// no param clears ALL (the /notifications page). Scoped to the caller. Never a
// hard delete.
export async function PATCH(req: Request) {
  let actor: Actor;
  try {
    actor = await requireNotificationsAccess();
  } catch (err) {
    const r = authErrorResponse(err);
    if (r) return r;
    throw err;
  }

  const cleared = await clearAllNotifications(actor.id, surfaceScope(req));
  const { bell, whatsapp, internalChat } = await countUnreadSplit(actor.id);
  return NextResponse.json({
    ok: true,
    cleared,
    unreadCount: bell,
    whatsappUnreadCount: whatsapp,
    internalChatUnreadCount: internalChat,
  });
}
