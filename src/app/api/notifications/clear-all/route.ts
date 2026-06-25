import { NextResponse } from 'next/server';
import { requireNotificationsAccess, type Actor } from '@/lib/auth/actor';
import { authErrorResponse } from '@/lib/auth/apiGuard';
import { clearAllNotifications, countUnreadSplit, WHATSAPP_MODULE } from '@/lib/db/notifications';
import { surfaceScope } from '../surface';

export const runtime = 'nodejs';

// PATCH /api/notifications/clear-all[?surface=bell|whatsapp] — soft-clear ACTIVE
// notifications (cleared_at=now()). Rows stay in the DB for audit + dedup but
// vanish from every tab. `?surface=bell` excludes WhatsApp, `?surface=whatsapp`
// is WhatsApp only; no param clears ALL (the /notifications page). Scoped to the
// caller. Never a hard delete.
export async function PATCH(req: Request) {
  let actor: Actor;
  try {
    actor = await requireNotificationsAccess();
  } catch (err) {
    const r = authErrorResponse(err);
    if (r) return r;
    throw err;
  }

  const cleared = await clearAllNotifications(actor.id, surfaceScope(req, WHATSAPP_MODULE));
  const { bell, whatsapp } = await countUnreadSplit(actor.id);
  return NextResponse.json({ ok: true, cleared, unreadCount: bell, whatsappUnreadCount: whatsapp });
}
