import { NextResponse, type NextRequest } from 'next/server';
import { requireActor, type Actor } from '@/lib/auth/actor';
import { authErrorResponse } from '@/lib/auth/apiGuard';
import { listNotificationsPage } from '@/lib/db/notifications';

export const runtime = 'nodejs';

// GET /api/notifications/list?module=&priority=&unread=&page= — the full,
// filtered, paginated stream for /notifications. Always scoped to the current
// user (a user can only ever see their own rows).
//   unread=1 → unread only; unread=0 → read only; absent → all.
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
  const module = sp.get('module') || undefined;
  const priority = sp.get('priority') || undefined;
  const unreadRaw = sp.get('unread');
  const unread = unreadRaw === '1' ? true : unreadRaw === '0' ? false : undefined;
  const pageRaw = Math.trunc(Number(sp.get('page')));
  const page = Number.isInteger(pageRaw) && pageRaw > 0 ? pageRaw : 1;
  const pageSize = 20;

  const { items, total } = await listNotificationsPage(actor.id, {
    module, priority, unread, page, pageSize,
  });
  return NextResponse.json({ items, total, page, pageSize });
}
