import { NextResponse, type NextRequest } from 'next/server';
import { requirePermission, type Actor } from '@/lib/auth/actor';
import { authErrorResponse } from '@/lib/auth/apiGuard';
import { getDebtorById, updateDebtorLegalStatus } from '@/lib/db/debtors';
import { sendStatusChangeNotification } from '@/services/email';

export const runtime = 'nodejs';

interface RouteCtx {
  params: Promise<{ id: string }>;
}

interface PutBody {
  status_id?: string | null;
}

export async function PUT(req: NextRequest, ctx: RouteCtx) {
  let actor: Actor;
  try {
    actor = await requirePermission('status_management', 'edit');
  } catch (err) {
    const r = authErrorResponse(err);
    if (r) return r;
    throw err;
  }

  const { id } = await ctx.params;

  let body: PutBody;
  try {
    body = (await req.json()) as PutBody;
  } catch {
    return NextResponse.json({ error: 'invalid_json' }, { status: 400 });
  }
  if (!('status_id' in body)) {
    return NextResponse.json({ error: 'missing_status_id' }, { status: 400 });
  }

  const changerName = actor.full_name || actor.username;
  let result;
  try {
    result = await updateDebtorLegalStatus(
      id,
      body.status_id ?? null,
      { id: actor.id, name: changerName },
    );
  } catch (err) {
    const msg = (err as Error).message;
    if (msg === 'debtor_not_found') return NextResponse.json({ error: 'not_found' }, { status: 404 });
    if (msg === 'status_not_found') return NextResponse.json({ error: 'invalid_status_id' }, { status: 400 });
    throw err;
  }

  // Notify recipients configured on the new status (non-blocking).
  const tenant = await getDebtorById(id);
  if (tenant && result.new.notification_emails && result.new.notification_emails.length > 0) {
    try {
      await sendStatusChangeNotification({
        apartment_number: tenant.apartment_number,
        owner_name: tenant.owner_name,
        old_status_name: result.old.name,
        new_status_name: result.new.name,
        changed_by_name: changerName,
        recipients: result.new.notification_emails,
      });
    } catch (err) {
      console.error('[legal-status] email notification failed', err);
    }
  }

  return NextResponse.json({ tenant, old: result.old, new: { id: result.new.id, name: result.new.name, color: result.new.color } });
}
