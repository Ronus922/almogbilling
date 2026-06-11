import { NextResponse, type NextRequest } from 'next/server';
import { requirePermission, type Actor } from '@/lib/auth/actor';
import { authErrorResponse } from '@/lib/auth/apiGuard';
import { withTransaction } from '@/lib/db';
import { logDebtorEvent, EVENT_TYPE_META } from '@/lib/debtor-events';

export const runtime = 'nodejs';

interface RouteCtx {
  params: Promise<{ id: string }>;
}

type ArchiveAction = 'archive' | 'restore';
type ArchiveResult = 'updated' | 'noop' | 'not_found';

// Flip is_archived and log the matching system event in one transaction.
// `target` = the desired is_archived value. Idempotent: a debtor already in the
// target state is a no-op (no second event written).
async function setArchived(
  id: string,
  target: boolean,
  action: ArchiveAction,
  actor: Actor,
): Promise<ArchiveResult> {
  return withTransaction(async (client) => {
    const r = await client.query<{ is_archived: boolean }>(
      `select is_archived from public.debtors where id = $1 for update`,
      [id],
    );
    const row = r.rows[0];
    if (!row) return 'not_found';
    if (row.is_archived === target) return 'noop';

    await client.query(
      `update public.debtors
          set is_archived = $2,
              archived_at = $3
        where id = $1`,
      [id, target, target ? new Date() : null],
    );

    const eventType = action === 'archive' ? 'ARCHIVE' : 'UNARCHIVE';
    await logDebtorEvent(client, {
      debtorId: id,
      eventType,
      title: EVENT_TYPE_META[eventType].label,
      actor: {
        id: actor.id,
        name: actor.full_name || actor.username,
        email: actor.email,
      },
    });
    return 'updated';
  });
}

// POST /api/debtors/[id]/archive — move a debtor to the archive tab.
export async function POST(_req: NextRequest, ctx: RouteCtx) {
  let actor: Actor;
  try {
    actor = await requirePermission('contacts', 'edit');
  } catch (err) {
    const r = authErrorResponse(err);
    if (r) return r;
    throw err;
  }

  const { id } = await ctx.params;
  const result = await setArchived(id, true, 'archive', actor);
  if (result === 'not_found') {
    return NextResponse.json({ error: 'not_found' }, { status: 404 });
  }
  return NextResponse.json({ success: true });
}

// DELETE /api/debtors/[id]/archive — restore a debtor from the archive.
export async function DELETE(_req: NextRequest, ctx: RouteCtx) {
  let actor: Actor;
  try {
    actor = await requirePermission('contacts', 'edit');
  } catch (err) {
    const r = authErrorResponse(err);
    if (r) return r;
    throw err;
  }

  const { id } = await ctx.params;
  const result = await setArchived(id, false, 'restore', actor);
  if (result === 'not_found') {
    return NextResponse.json({ error: 'not_found' }, { status: 404 });
  }
  return NextResponse.json({ success: true });
}
