import { NextResponse } from 'next/server';
import { queryOne } from '@/lib/db';
import { requirePermission } from '@/lib/auth/actor';
import { authErrorResponse } from '@/lib/auth/apiGuard';
import { parseJsonBody } from '@/lib/http/body';
import { ownerPhoneCreateBodySchema, ownerPhoneUpdateBodySchema } from '@/lib/validation/requests';
import { OWNER_PHONE_RULE_MESSAGE, toPortalE164 } from '@/lib/portal/phone';
import { createOwnerPhone, listOwnerPhones, updateOwnerPhone } from '@/lib/db/portal/ownerPhones';
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

export async function POST(req: Request, { params }: Params) {
  try {
    const actor = await requirePermission('portal_manage', 'edit');
    const { apartment } = await params;
    if (!(await apartmentExists(apartment))) {
      return NextResponse.json({ error: 'הדירה לא נמצאה' }, { status: 404 });
    }

    const body = await parseJsonBody(req, ownerPhoneCreateBodySchema);
    if (!body.ok) return body.response;

    // Israeli mobile, or a foreign number in E.164 — the code travels over
    // WhatsApp, so an Israeli landline row would be a roster entry that can
    // never sign in. Same rule as the table's CHECK and the login.
    const phoneE164 = toPortalE164(body.data.phone);
    if (!phoneE164) {
      return NextResponse.json(
        { error: OWNER_PHONE_RULE_MESSAGE },
        { status: 400 },
      );
    }

    const created = await createOwnerPhone({
      apartmentNumber: apartment,
      ownerName: body.data.owner_name,
      phoneE164,
      createdBy: actor.id,
    });
    if (!created) {
      return NextResponse.json({ error: 'המספר כבר רשום לדירה הזו' }, { status: 409 });
    }

    await writeAudit({
      actorUserId: actor.id,
      action: 'portal_owner_phone_added',
      entityType: 'apartment_owner_phone',
      entityId: created.id,
      metadata: { apartment_number: apartment, phone_e164: phoneE164 },
    });
    return NextResponse.json(created, { status: 201 });
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

    const body = await parseJsonBody(req, ownerPhoneUpdateBodySchema);
    if (!body.ok) return body.response;

    const updated = await updateOwnerPhone(apartment, body.data.id, {
      ownerName: body.data.owner_name,
      isActive: body.data.is_active,
    });
    if (!updated) {
      return NextResponse.json({ error: 'המספר לא נמצא בדירה הזו' }, { status: 404 });
    }

    // Deactivating revokes the open sessions of that phone right away, instead of
    // waiting for its next request to notice. Only when the phone has no ACTIVE
    // row left anywhere: the same number may still own another apartment.
    if (body.data.is_active === false) {
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
            details: { reason: 'deactivated_by_admin', sessions: revoked, by: actor.username },
          });
        }
      }
    }

    await writeAudit({
      actorUserId: actor.id,
      action: body.data.is_active === false ? 'portal_owner_phone_deactivated' : 'portal_owner_phone_updated',
      entityType: 'apartment_owner_phone',
      entityId: updated.id,
      metadata: { apartment_number: apartment, phone_e164: updated.phone_e164 },
    });
    return NextResponse.json(updated);
  } catch (err) {
    const res = authErrorResponse(err);
    if (res) return res;
    throw err;
  }
}
