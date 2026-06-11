import { NextResponse, type NextRequest } from 'next/server';
import { requirePermission, type Actor } from '@/lib/auth/actor';
import { authErrorResponse } from '@/lib/auth/apiGuard';
import { withTransaction } from '@/lib/db';
import {
  logDebtorEvent,
  isManualEventType,
  EVENT_TYPE_META,
} from '@/lib/debtor-events';

export const runtime = 'nodejs';

interface RouteCtx {
  params: Promise<{ id: string }>;
}

// POST /api/debtors/[id]/events — create a manual documentation entry
// (call / SMS / WhatsApp / email / meeting / other). Same permission gate as
// adding a comment: contacts:edit.
export async function POST(req: NextRequest, ctx: RouteCtx) {
  let actor: Actor;
  try {
    actor = await requirePermission('contacts', 'edit');
  } catch (err) {
    const r = authErrorResponse(err);
    if (r) return r;
    throw err;
  }

  const { id } = await ctx.params;

  let body: { event_type?: unknown; description?: unknown; outcome?: unknown };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: 'invalid_json' }, { status: 400 });
  }

  if (!isManualEventType(body.event_type)) {
    return NextResponse.json({ error: 'invalid_event_type' }, { status: 400 });
  }
  const eventType = body.event_type;

  const description = typeof body.description === 'string' ? body.description.trim() : '';
  if (description.length === 0) {
    return NextResponse.json({ error: 'empty_description' }, { status: 400 });
  }
  const outcomeRaw = typeof body.outcome === 'string' ? body.outcome.trim() : '';
  const outcome = outcomeRaw.length > 0 ? outcomeRaw : null;

  const actorName = actor.full_name || actor.username;

  try {
    await withTransaction(async (client) => {
      const r = await client.query<{ id: string }>(
        `select id from public.debtors where id = $1 for update`,
        [id],
      );
      if (r.rowCount === 0) throw new Error('not_found');

      await logDebtorEvent(client, {
        debtorId: id,
        eventType,
        title: EVENT_TYPE_META[eventType].label,
        description,
        outcome,
        actor: { id: actor.id, name: actorName, email: actor.email },
      });

      // Documenting an interaction counts as contact — refresh last_contact_date.
      await client.query(
        `update public.debtors set last_contact_date = current_date where id = $1`,
        [id],
      );
    });
  } catch (err) {
    if ((err as Error).message === 'not_found') {
      return NextResponse.json({ error: 'not_found' }, { status: 404 });
    }
    throw err;
  }

  return NextResponse.json({ success: true }, { status: 201 });
}
