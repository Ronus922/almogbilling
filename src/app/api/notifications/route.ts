import { NextResponse, type NextRequest } from 'next/server';
import { requireNotificationsAccess, type Actor } from '@/lib/auth/actor';
import { authErrorResponse } from '@/lib/auth/apiGuard';
import {
  listNotifications,
  countUnread,
  markNotificationRead,
  markAllNotificationsRead,
  WHATSAPP_MODULE,
} from '@/lib/db/notifications';

export const runtime = 'nodejs';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Bell-panel tabs → list filter. 'all' = every active row; 'unread' = is_read
// false; a module name = that source_module. Always active-only (cleared_at IS
// NULL is enforced in the db layer).
const MODULE_TABS = new Set(['tasks', 'issues', 'calendar', 'whatsapp', 'internal_chat']);

// GET /api/notifications?tab=all|unread|<module>&limit=10 — the CURRENT user's
// ACTIVE notifications only. Legacy ?unread=1 still honoured.
export async function GET(req: NextRequest) {
  let actor: Actor;
  try {
    actor = await requireNotificationsAccess();
  } catch (err) {
    const r = authErrorResponse(err);
    if (r) return r;
    throw err;
  }

  const sp = req.nextUrl.searchParams;
  const tab = sp.get('tab') ?? '';
  const limitRaw = Math.trunc(Number(sp.get('limit')));
  const limit = Number.isInteger(limitRaw) && limitRaw > 0 ? limitRaw : 30;

  const onlyUnread = tab === 'unread' || sp.get('unread') === '1';
  const module = MODULE_TABS.has(tab) ? tab : undefined;
  const isWhatsapp = module === WHATSAPP_MODULE;

  // The bell surface is everything EXCEPT WhatsApp; the WhatsApp dropdown
  // (tab=whatsapp) is WhatsApp only. The two never overlap, so the returned
  // unreadCount matches the surface the caller is rendering (no double-count).
  const scope = isWhatsapp
    ? { module: WHATSAPP_MODULE }
    : module
      ? { module } // a non-WhatsApp module tab (tasks/issues/calendar/internal_chat)
      : { excludeModule: WHATSAPP_MODULE }; // all / unread → bell surface

  const [items, unreadCount] = await Promise.all([
    listNotifications(actor.id, { onlyUnread, limit, ...scope }),
    // Badge count tracks the surface: WhatsApp-only for tab=whatsapp, else the
    // bell count (every active unread except WhatsApp).
    countUnread(actor.id, isWhatsapp ? { module: WHATSAPP_MODULE } : { excludeModule: WHATSAPP_MODULE }),
  ]);
  return NextResponse.json({ items, unreadCount });
}

// PATCH /api/notifications — mark read. Body: { id } (single) OR { all: true }.
// Always scoped to the current user (a user can never touch another's rows).
export async function PATCH(req: NextRequest) {
  let actor: Actor;
  try {
    actor = await requireNotificationsAccess();
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
