import { NextResponse } from 'next/server';
import { queryOne } from '@/lib/db';
import { requirePermission } from '@/lib/auth/actor';
import { authErrorResponse } from '@/lib/auth/apiGuard';
import { parseJsonBody } from '@/lib/http/body';
import { ownerPhoneDetachBodySchema } from '@/lib/validation/requests';
import { detachOwnerPhone, listOwnerPhones } from '@/lib/db/portal/ownerPhones';
import { revokePortalSessionsForPhone } from '@/lib/db/portal/sessions';
import { logPortalEvent } from '@/lib/db/portal/events';
import { writeAudit } from '@/lib/db/audit';

export const runtime = 'nodejs';

// /api/apartments/[apartment]/owner-phones — the portal roster of ONE apartment.
// Staff endpoint: `portal_manage` (admin / super_admin), never the portal guard.
//
// The apartment is addressed by apartment_number — the same key the roster's FK
// uses — so it is validated against public.contacts before anything else: a
// number that is not an apartment is a 404, not a row with a dangling FK.
//
// VIEW and DETACH only (decision 5 of the 03/10/2026 audit). There is no POST:
// a phone reaches the portal through the apartment's owner record and nothing
// else — the roster mirrors those records (migration 20261003095149) — so an
// admin cannot add a link, rename one or switch a detached one back on. A
// missing method answers 405 from the framework itself.

type Params = { params: Promise<{ apartment: string }> };

async function apartmentExists(apartmentNumber: string): Promise<boolean> {
  const row = await queryOne<{ n: number }>(
    `select 1 as n from public.contacts where apartment_number = $1 limit 1`,
    [apartmentNumber],
  );
  return row !== null;
}

export async function GET(_req: Request, { params }: Params) {
  try {
    await requirePermission('portal_manage', 'view');
    const { apartment } = await params;
    if (!(await apartmentExists(apartment))) {
      return NextResponse.json({ error: 'הדירה לא נמצאה' }, { status: 404 });
    }
    return NextResponse.json({ items: await listOwnerPhones(apartment) });
  } catch (err) {
    const res = authErrorResponse(err);
    if (res) return res;
    throw err;
  }
}

export async function PATCH(req: Request, { params }: Params) {
  try {
    const actor = await requirePermission('portal_manage', 'edit');
    const { apartment } = await params;

    const body = await parseJsonBody(req, ownerPhoneDetachBodySchema);
    if (!body.ok) return body.response;

    const updated = await detachOwnerPhone(apartment, body.data.id, actor.id);
    if (!updated) {
      return NextResponse.json({ error: 'השיוך לא נמצא בדירה הזו או שכבר נותק' }, { status: 404 });
    }

    // Detaching revokes the open sessions of that phone right away, instead of
    // waiting for its next request to notice. Only when the phone has no ACTIVE
    // row left anywhere: the same number may still own another apartment.
    const stillActive = await queryOne<{ n: number }>(
      `select 1 as n from public.apartment_owner_phones
        where phone_e164 = $1 and is_active limit 1`,
      [updated.phone_e164],
    );
    if (!stillActive) {
      const revoked = await revokePortalSessionsForPhone(updated.phone_e164);
      // Log it here too: this endpoint closes the session BEFORE the resident's
      // next request, so getPortalSession() never sees it and never logs it.
      if (revoked > 0) {
        await logPortalEvent({
          phoneE164: updated.phone_e164,
          eventType: 'session_revoked',
          apartmentNumbers: [apartment],
          details: { reason: 'detached_by_admin', sessions: revoked, by: actor.username },
        });
      }
    }

    await writeAudit({
      actorUserId: actor.id,
      action: 'portal_owner_phone_detached',
      entityType: 'apartment_owner_phone',
      entityId: updated.id,
      metadata: {
        apartment_number: apartment,
        phone_e164: updated.phone_e164,
        owner_name: updated.owner_name,
        reason: 'admin',
      },
    });
    return NextResponse.json(updated);
  } catch (err) {
    const res = authErrorResponse(err);
    if (res) return res;
    throw err;
  }
}
