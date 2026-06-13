import { NextResponse, type NextRequest } from 'next/server';
import { requireActor, type Actor } from '@/lib/auth/actor';
import { authErrorResponse } from '@/lib/auth/apiGuard';
import {
  listNotifications,
  countUnread,
  markNotificationRead,
  markAllNotificationsRead,
} from '@/lib/db/notifications';

export const runtime = 'nodejs';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// GET /api/notifications?unread=1&limit=30 — the CURRENT user's notifications only.
export async function GET(req: NextRequest) {
  let actor: Actor;
  try {
    actor = await requireActor();
  } catch (err) {
    const r = authErrorResponse(err);
    if (r) return r;
    throw err;
  }

  const sp = req.nextUrl.searchParams;
  const onlyUnread = sp.get('unread') === '1';
  const limitRaw = Math.trunc(Number(sp.get('limit')));
  const limit = Number.isInteger(limitRaw) && limitRaw > 0 ? limitRaw : 30;

  const [items, unreadCount] = await Promise.all([
    listNotifications(actor.id, { onlyUnread, limit }),
    countUnread(actor.id),
  ]);
  return NextResponse.json({ items, unreadCount });
}

// PATCH /api/notifications — mark read. Body: { id } (single) OR { all: true }.
// Always scoped to the current user (a user can never touch another's rows).
export async function PATCH(req: NextRequest) {
  let actor: Actor;
  try {
    actor = await requireActor();
  } catch (err) {
    const r = authErrorResponse(err);
    if (r) return r;
    throw err;
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'invalid_json' }, { status: 400 });
  }
  const rec = (body ?? {}) as Record<string, unknown>;

  if (rec.all === true) {
    const updated = await markAllNotificationsRead(actor.id);
    const unreadCount = await countUnread(actor.id);
    return NextResponse.json({ ok: true, updated, unreadCount });
  }

  const id = typeof rec.id === 'string' ? rec.id : '';
  if (!UUID_RE.test(id)) return NextResponse.json({ error: 'invalid_id' }, { status: 400 });

  await markNotificationRead(id, actor.id);
  const unreadCount = await countUnread(actor.id);
  return NextResponse.json({ ok: true, unreadCount });
}
