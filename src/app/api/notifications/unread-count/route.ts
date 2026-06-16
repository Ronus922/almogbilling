import { NextResponse } from 'next/server';
import { requireActor, type Actor } from '@/lib/auth/actor';
import { authErrorResponse } from '@/lib/auth/apiGuard';
import { countUnread } from '@/lib/db/notifications';

export const runtime = 'nodejs';

// GET /api/notifications/unread-count → { count } — the lightweight 60s poll
// target for the bell badge. Always scoped to the current user.
export async function GET() {
  let actor: Actor;
  try {
    actor = await requireActor();
  } catch (err) {
    const r = authErrorResponse(err);
    if (r) return r;
    throw err;
  }

  const count = await countUnread(actor.id);
  return NextResponse.json({ count });
}
