import { NextResponse, type NextRequest } from 'next/server';
import { requirePermission, type Actor } from '@/lib/auth/actor';
import { authErrorResponse } from '@/lib/auth/apiGuard';
import { withTransaction } from '@/lib/db';
import { insertCompletedAction } from '@/lib/db/completedActions';

export const runtime = 'nodejs';

interface RouteCtx {
  params: Promise<{ id: string }>;
}

interface DebtorRow {
  apartment_number: string;
  next_action_description: string | null;
  next_action_date: string | null;
}

const FALLBACK_DESCRIPTION = '(ללא תיאור)';

export async function POST(_req: NextRequest, ctx: RouteCtx) {
  let actor: Actor;
  try {
    actor = await requirePermission('dashboard', 'edit');
  } catch (err) {
    const r = authErrorResponse(err);
    if (r) return r;
    throw err;
  }

  const { id } = await ctx.params;
  const userName = actor.full_name || actor.username;

  try {
    await withTransaction(async (client) => {
      const r = await client.query<DebtorRow>(
        `select apartment_number, next_action_description, next_action_date
           from public.debtors
           where id = $1
           for update`,
        [id],
      );
      const row = r.rows[0];
      if (!row) throw new Error('not_found');
      if (!row.next_action_description && !row.next_action_date) {
        throw new Error('no_pending_action');
      }

      await insertCompletedAction(client, {
        debtor_id: id,
        apartment_number: row.apartment_number,
        description: row.next_action_description ?? FALLBACK_DESCRIPTION,
        due_date: row.next_action_date,
        completed_by: actor.id,
        completed_by_name: userName,
      });

      await client.query(
        `update public.debtors
            set next_action_description = null,
                next_action_date         = null,
                last_contact_date        = current_date
          where id = $1`,
        [id],
      );
    });
  } catch (err) {
    const msg = (err as Error).message;
    if (msg === 'not_found') return NextResponse.json({ error: 'not_found' }, { status: 404 });
    if (msg === 'no_pending_action') {
      return NextResponse.json({ error: 'no_pending_action' }, { status: 400 });
    }
    throw err;
  }

  return NextResponse.json({ success: true });
}
