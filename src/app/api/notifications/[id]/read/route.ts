import { NextResponse } from 'next/server';
import { requireNotificationsAccess, type Actor } from '@/lib/auth/actor';
import { authErrorResponse } from '@/lib/auth/apiGuard';
import { markNotificationReadOwned, countUnread } from '@/lib/db/notifications';

export const runtime = 'nodejs';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// PATCH /api/notifications/[id]/read — mark ONE notification read. Ownership is
// enforced in the WHERE clause: a row that isn't the caller's (or doesn't exist)
// returns 404 — never leaks another user's notifications.
export async function PATCH(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  let actor: Actor;
  try {
    actor = await requireNotificationsAccess();
  } catch (err) {
    const r = authErrorResponse(err);
    if (r) return r;
    throw err;
  }

  const { id } = await ctx.params;
  if (!UUID_RE.test(id)) return NextResponse.json({ error: 'invalid_id' }, { status: 400 });

  const ok = await markNotificationReadOwned(id, actor.id);
  if (!ok) return NextResponse.json({ error: 'not_found' }, { status: 404 });

  const unreadCount = await countUnread(actor.id);
  return NextResponse.json({ ok: true, unreadCount });
}
