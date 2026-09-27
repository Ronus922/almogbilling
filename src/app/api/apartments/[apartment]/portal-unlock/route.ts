import { NextResponse } from 'next/server';
import { queryOne } from '@/lib/db';
import { requirePermission } from '@/lib/auth/actor';
import { authErrorResponse } from '@/lib/auth/apiGuard';
import { parseJsonBody } from '@/lib/http/body';
import { portalUnlockBodySchema } from '@/lib/validation/requests';
import { toPortalE164 } from '@/lib/portal/phone';
import { releaseLockouts } from '@/lib/db/portal/lockouts';
import { logPortalEvent } from '@/lib/db/portal/events';
import { writeAudit } from '@/lib/db/audit';

export const runtime = 'nodejs';

// POST /api/apartments/[apartment]/portal-unlock — "שחרר חסימה" on the card.
// `portal_manage:edit` (admin / super_admin).
//
// Releasing KEEPS the lockout rows (released_at is stamped, nothing is deleted),
// so the escalation history survives: a phone released twice today still reaches
// tier 3 on its next offence. The phone must belong to THIS apartment, or one
// apartment's card could unlock a number it has nothing to do with.
export async function POST(req: Request, { params }: { params: Promise<{ apartment: string }> }) {
  try {
    const actor = await requirePermission('portal_manage', 'edit');
    const { apartment } = await params;

    const body = await parseJsonBody(req, portalUnlockBodySchema);
    if (!body.ok) return body.response;

    const phoneE164 = toPortalE164(body.data.phone);
    if (!phoneE164) {
      return NextResponse.json({ error: 'מספר טלפון לא תקין' }, { status: 400 });
    }

    const belongs = await queryOne<{ n: number }>(
      `select 1 as n from public.apartment_owner_phones
        where apartment_number = $1 and phone_e164 = $2 limit 1`,
      [apartment, phoneE164],
    );
    if (!belongs) {
      return NextResponse.json({ error: 'המספר לא רשום לדירה הזו' }, { status: 404 });
    }

    const released = await releaseLockouts(phoneE164, actor.id);
    if (released === 0) {
      return NextResponse.json({ error: 'אין חסימה פעילה למספר הזה' }, { status: 404 });
    }

    await logPortalEvent({
      phoneE164,
      eventType: 'unlocked_manually',
      apartmentNumbers: [apartment],
      details: { released, by: actor.username },
    });
    await writeAudit({
      actorUserId: actor.id,
      action: 'portal_lockout_released',
      entityType: 'portal_lockout',
      metadata: { apartment_number: apartment, phone_e164: phoneE164, released },
    });
    return NextResponse.json({ ok: true, released });
  } catch (err) {
    const res = authErrorResponse(err);
    if (res) return res;
    throw err;
  }
}
