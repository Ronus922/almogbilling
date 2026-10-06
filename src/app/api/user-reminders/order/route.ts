import { NextResponse, type NextRequest } from 'next/server';
import { requirePermission, type Actor } from '@/lib/auth/actor';
import { authErrorResponse } from '@/lib/auth/apiGuard';
import { setUserReminderOrder } from '@/lib/db/userReminders';
import { parseJsonBody } from '@/lib/http/body';
import { reminderOrderBodySchema } from '@/lib/validation/requests';
import { logger } from '@/lib/logger';

export const runtime = 'nodejs';

// PUT /api/user-reminders/order  (user_reminders:view)
// Body: { ids: uuid[] } — the reminders of the tab the user dragged in, top to
// bottom. Writes the SESSION user's rows of user_reminder_order alone, positions
// 0..n-1 for exactly these ids (06/10/2026, per-user order): the other person a
// reminder is shared with keeps their own list as it was. Every id must be a
// live reminder the user is involved in — created by them or assigned to them
// — else 404 (unknown / archived) or 403 (someone else's), and nothing is
// written. The order is the user's own view, not an edit of any reminder, so
// the module's view permission is enough.
export async function PUT(req: NextRequest) {
  let actor: Actor;
  try {
    actor = await requirePermission('user_reminders', 'view');
  } catch (err) {
    const r = authErrorResponse(err);
    if (r) return r;
    throw err;
  }

  const body = await parseJsonBody(req, reminderOrderBodySchema);
  if (!body.ok) return body.response;

  try {
    const result = await setUserReminderOrder(actor.id, body.data.ids);
    switch (result) {
      case 'ok':
        return NextResponse.json({ ok: true });
      case 'not_found':
        return NextResponse.json({ error: 'not_found' }, { status: 404 });
      case 'forbidden':
        return NextResponse.json({ error: 'forbidden' }, { status: 403 });
    }
  } catch (err) {
    logger.error('[PUT /api/user-reminders/order]', err);
    return NextResponse.json({ error: 'server_error' }, { status: 500 });
  }
}
