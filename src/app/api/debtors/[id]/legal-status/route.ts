import { NextResponse, type NextRequest } from 'next/server';
import { requirePermission, type Actor } from '@/lib/auth/actor';
import { authErrorResponse } from '@/lib/auth/apiGuard';
import { getDebtorById, updateDebtorLegalStatus } from '@/lib/db/debtors';
import { sendStatusChangeNotification } from '@/services/email';
import { getLegalContact } from '@/lib/db/appSettings';
import { isLegalStatusName } from '@/lib/constants/statuses';
import { buildLegalStatusRecipients } from '@/lib/notify/legalStatusRecipients';
import { logger } from '@/lib/logger';
import { parseJsonBody } from '@/lib/http/body';
import { legalStatusBodySchema } from '@/lib/validation/requests';

export const runtime = 'nodejs';

interface RouteCtx {
  params: Promise<{ id: string }>;
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

  const body = await parseJsonBody(req, legalStatusBodySchema);
  if (!body.ok) return body.response;

  const changerName = actor.full_name || actor.username;
  let result;
  try {
    result = await updateDebtorLegalStatus(
      id,
      body.data.status_id,
      { id: actor.id, name: changerName },
    );
  } catch (err) {
    const msg = (err as Error).message;
    if (msg === 'debtor_not_found') return NextResponse.json({ error: 'not_found' }, { status: 404 });
    if (msg === 'status_not_found') return NextResponse.json({ error: 'invalid_status_id' }, { status: 400 });
    throw err;
  }

  // Notify (non-blocking): the recipients configured on the new status, plus
  // the legal contact from Settings when the debtor moved INTO a legal status.
  // The lawyer's address is a setting, never a constant here.
  const tenant = await getDebtorById(id);
  if (tenant) {
    try {
      const legal = isLegalStatusName(result.new.name) ? await getLegalContact() : null;
      const recipients = buildLegalStatusRecipients({
        statusEmails: result.new.notification_emails,
        newStatusName: result.new.name,
        legalEmail: legal?.email,
      });
      if (recipients.length > 0) {
        await sendStatusChangeNotification({
          apartment_number: tenant.apartment_number,
          owner_name: tenant.owner_name,
          old_status_name: result.old.name,
          new_status_name: result.new.name,
          changed_by_name: changerName,
          recipients,
        });
      }
    } catch (err) {
      logger.error('[legal-status] email notification failed', err);
    }
  }

  return NextResponse.json({ tenant, old: result.old, new: { id: result.new.id, name: result.new.name, color: result.new.color } });
}
