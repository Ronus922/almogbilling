import { NextResponse } from 'next/server';
import { requireNotificationsAccess, type Actor } from '@/lib/auth/actor';
import { authErrorResponse } from '@/lib/auth/apiGuard';
import { markAllNotificationsRead, countUnreadSplit } from '@/lib/db/notifications';
import { surfaceScope } from '../surface';

export const runtime = 'nodejs';

// PATCH /api/notifications/read-all[?surface=bell|whatsapp|internal_chat] — mark
// unread read (is_read=true). Scoped to the caller. `?surface=bell` excludes the
// dedicated modules (bell "mark all"); `?surface=whatsapp` / `?surface=internal_chat`
// are that module only (dropdown "mark all"); no param marks ALL (the
// /notifications page) — so each header surface never clears another's badge.
export async function PATCH(req: Request) {
  let actor: Actor;
  try {
    actor = await requireNotificationsAccess();
  } catch (err) {
    const r = authErrorResponse(err);
    if (r) return r;
    throw err;
  }

  const updated = await markAllNotificationsRead(actor.id, surfaceScope(req));
  const { bell, whatsapp, internalChat } = await countUnreadSplit(actor.id);
  return NextResponse.json({
    ok: true,
    updated,
    unreadCount: bell,
    whatsappUnreadCount: whatsapp,
    internalChatUnreadCount: internalChat,
  });
}
