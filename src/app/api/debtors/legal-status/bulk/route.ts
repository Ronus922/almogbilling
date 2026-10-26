import { NextResponse, type NextRequest } from 'next/server';
import { requireAdmin, type Actor } from '@/lib/auth/actor';
import { authErrorResponse } from '@/lib/auth/apiGuard';
import { bulkUpdateDebtorLegalStatus, DebtorsNotFoundError } from '@/lib/db/debtors';
import { sendBulkStatusChangeNotification } from '@/services/email';
import { getLegalContact } from '@/lib/db/appSettings';
import { isLegalStatusName } from '@/lib/constants/statuses';
import { buildLegalStatusRecipients } from '@/lib/notify/legalStatusRecipients';
import { logger } from '@/lib/logger';
import { parseJsonBody } from '@/lib/http/body';
import { legalStatusBulkBodySchema } from '@/lib/validation/requests';

export const runtime = 'nodejs';

// PUT /api/debtors/legal-status/bulk — body { debtor_ids, status_id }
//
// One legal status for many apartments, all or nothing (see
// bulkUpdateDebtorLegalStatus). Admin / super admin only — a role guard, not
// the status_management matrix key the single-apartment route uses: the bulk
// action is deliberately narrower than "may change one status" (a manager keeps
// the single change). Does not touch /api/debtors/[id]/legal-status.
export async function PUT(req: NextRequest) {
  let actor: Actor;
  try {
    actor = await requireAdmin();
  } catch (err) {
    const r = authErrorResponse(err);
    if (r) return r;
    throw err;
  }

  const body = await parseJsonBody(req, legalStatusBulkBodySchema);
  if (!body.ok) return body.response;

  const changerName = actor.full_name || actor.username;
  let result;
  try {
    result = await bulkUpdateDebtorLegalStatus(
      body.data.debtor_ids,
      body.data.status_id,
      { id: actor.id, name: changerName },
    );
  } catch (err) {
    if (err instanceof DebtorsNotFoundError) {
      return NextResponse.json({ error: 'debtor_not_found', missing_ids: err.missingIds }, { status: 404 });
    }
    if ((err as Error).message === 'status_not_found') {
      return NextResponse.json({ error: 'invalid_status_id' }, { status: 400 });
    }
    throw err;
  }

  // ONE consolidated mail (non-blocking), to the same recipients the
  // single-apartment route would use: the new status's notification_emails,
  // plus the lawyer from Settings when the new status is a legal one.
  let email: { sent: number; failed: number } | null = null;
  if (result.changed.length > 0) {
    try {
      const legal = isLegalStatusName(result.new.name) ? await getLegalContact() : null;
      const recipients = buildLegalStatusRecipients({
        statusEmails: result.new.notification_emails,
        newStatusName: result.new.name,
        legalEmail: legal?.email,
      });
      if (recipients.length > 0) {
        email = await sendBulkStatusChangeNotification({
          new_status_name: result.new.name,
          changes: result.changed.map((c) => ({
            apartment_number: c.apartment_number,
            owner_name: c.owner_name,
            old_status_name: c.old_status_name,
          })),
          changed_by_name: changerName,
          recipients,
        });
      }
    } catch (err) {
      logger.error('[legal-status/bulk] email notification failed', err);
      email = { sent: 0, failed: 1 };
    }
  }

  return NextResponse.json({
    updated: result.changed.length,
    skipped: result.skipped,
    new: { id: result.new.id, name: result.new.name, color: result.new.color },
    email,
  });
}
