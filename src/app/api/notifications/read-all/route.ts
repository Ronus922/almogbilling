import { NextResponse } from 'next/server';
import { requireNotificationsAccess, type Actor } from '@/lib/auth/actor';
import { authErrorResponse } from '@/lib/auth/apiGuard';
import { markAllNotificationsRead, countUnreadSplit, WHATSAPP_MODULE } from '@/lib/db/notifications';
import { surfaceScope } from '../surface';

export const runtime = 'nodejs';

// PATCH /api/notifications/read-all[?surface=bell|whatsapp] — mark unread read
// (is_read=true). Scoped to the caller. `?surface=bell` excludes WhatsApp (bell
// "mark all"), `?surface=whatsapp` is WhatsApp only (dropdown "mark all"); no
// param marks ALL (the /notifications page) — so each header surface never
// clears the other's badge.
export async function PATCH(req: Request) {
  let actor: Actor;
  try {
    actor = await requireNotificationsAccess();
  } catch (err) {
    const r = authErrorResponse(err);
    if (r) return r;
    throw err;
  }

  const updated = await markAllNotificationsRead(actor.id, surfaceScope(req, WHATSAPP_MODULE));
  const { bell, whatsapp } = await countUnreadSplit(actor.id);
  return NextResponse.json({ ok: true, updated, unreadCount: bell, whatsappUnreadCount: whatsapp });
}
