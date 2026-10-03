import { NextResponse, type NextRequest } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { requirePermission, type Actor } from '@/lib/auth/actor';
import { authErrorResponse } from '@/lib/auth/apiGuard';
import {
  getContactById, updateContact, deleteContact,
  ACTIVE_DEBT_DELETE_BLOCKED_SQLSTATE,
} from '@/lib/db/contacts';
import { withTransaction } from '@/lib/db';
import { replaceContactPeople } from '@/lib/db/contactPeople';
import { coerceContactInput, coerceContactPeople } from '@/lib/validation/contacts';
import { getBillingSettings } from '@/lib/db/appSettings';
import { computeManagementFee } from '@/lib/billing/managementFee';
import { logger } from '@/lib/logger';
import { hasPermission } from '@/lib/permissions/check';
import { phoneEntryDecisionsSchema } from '@/lib/validation/requests';
import {
  checkPhoneEntry, IdentityDecisionError, PhoneEntryConflictError, registrationsOf,
} from '@/lib/db/portal/identityApprovals';

export const runtime = 'nodejs';

interface RouteCtx {
  params: Promise<{ id: string }>;
}

// GET /api/contacts/[id] — any authenticated user.
export async function GET(_req: NextRequest, ctx: RouteCtx) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });

  const { id } = await ctx.params;
  const contact = await getContactById(id);
  if (!contact) return NextResponse.json({ error: 'not_found' }, { status: 404 });
  return NextResponse.json({ contact });
}

// PATCH /api/contacts/[id] — contacts:edit. apartment_number is ignored (immutable).
//
// The entry warning (03/10/2026): a save that puts a phone on this card which
// ANOTHER apartment carries under ANOTHER name answers 409
// { error: 'phone_conflict', conflicts } and saves NOTHING; the card asks
// "אותו אדם?" and sends the answers back as `phone_decisions`
// (lib/db/portal/identityApprovals.ts → checkPhoneEntry).
export async function PATCH(req: NextRequest, ctx: RouteCtx) {
  let actor: Actor;
  try {
    actor = await requirePermission('contacts', 'edit');
  } catch (err) {
    const r = authErrorResponse(err);
    if (r) return r;
    throw err;
  }

  const { id } = await ctx.params;

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'invalid_json' }, { status: 400 });
  }

  const rec = (body ?? {}) as Record<string, unknown>;
  const result = coerceContactInput(rec, 'update');
  if (!result.ok) {
    return NextResponse.json({ error: result.error }, { status: 400 });
  }

  // Extra owners/tenants — the client sends the COMPLETE list, so it replaces
  // what is stored. Omitting the key leaves the existing rows untouched.
  const peopleResult = rec.people === undefined ? null : coerceContactPeople(rec.people);
  if (peopleResult && !peopleResult.ok) {
    return NextResponse.json({ error: peopleResult.error }, { status: 400 });
  }

  const decisions = rec.phone_decisions === undefined ? null : phoneEntryDecisionsSchema.safeParse(rec.phone_decisions);
  if (decisions && !decisions.success) {
    return NextResponse.json({ error: 'invalid_phone_decisions' }, { status: 400 });
  }

  // management_fee is DERIVED — see POST /api/contacts. On a partial update the
  // size may not be in the payload, so fall back to the stored one.
  const { managementFeePerSqm } = await getBillingSettings();
  if (managementFeePerSqm !== null) {
    const size = result.fields.apartment_size_sqm !== undefined
      ? result.fields.apartment_size_sqm
      : (await getContactById(id))?.apartment_size_sqm ?? null;
    const derivedFee = computeManagementFee(size, managementFeePerSqm);
    if (derivedFee !== null) result.fields.management_fee = derivedFee;
  }

  try {
    // The contact and its people in ONE transaction: the portal roster is
    // recomputed from both at COMMIT (migration 20261003095149), so a phone
    // moved between the owner field and the people list never looks removed.
    const updated = await withTransaction(async (client) => {
      const apt = await client.query<{ apartment_number: string }>(
        `select apartment_number from public.contacts where id = $1`,
        [id],
      );
      const apartment = apt.rows[0]?.apartment_number;
      const before = apartment ? await registrationsOf(client, apartment) : [];
      const row = await updateContact(id, result.fields, client);
      if (row && peopleResult) await replaceContactPeople(id, peopleResult.people, client);
      if (row) {
        await checkPhoneEntry(client, {
          apartment: row.apartment_number,
          before,
          decisions: decisions?.data,
          actor: { id: actor.id, canManagePortal: hasPermission(actor.role, actor.permissions, 'portal_manage', 'edit') },
        });
      }
      return row;
    });
    if (!updated) return NextResponse.json({ error: 'not_found' }, { status: 404 });
    const contact = peopleResult ? (await getContactById(id)) ?? updated : updated;
    return NextResponse.json({ contact });
  } catch (err) {
    if (err instanceof PhoneEntryConflictError) {
      // can_approve: a "yes" from this user approves the identity there and
      // then (portal_manage), so the card also asks for the name and relations.
      return NextResponse.json({
        error: 'phone_conflict',
        conflicts: err.conflicts,
        can_approve: hasPermission(actor.role, actor.permissions, 'portal_manage', 'edit'),
      }, { status: 409 });
    }
    if (err instanceof IdentityDecisionError) {
      return NextResponse.json({ error: err.message }, { status: 400 });
    }
    const e = err as { code?: string };
    if (e.code === '23503') {
      return NextResponse.json({ error: 'invalid_reference' }, { status: 400 });
    }
    logger.error('[PATCH /api/contacts/:id]', err);
    return NextResponse.json({ error: 'server_error' }, { status: 500 });
  }
}

// DELETE /api/contacts/[id] — contacts:edit. Two DB-level guards, both
// surfaced below with an explicit reason instead of a raw 500:
//   - wa_campaign_recipients.contact_id is ON DELETE RESTRICT (23503) — a
//     contact that ever received a broadcast can't be deleted.
//   - a BEFORE DELETE trigger (ACTIVE_DEBT_DELETE_BLOCKED_SQLSTATE) blocks a
//     contact with an active (non-archived) debtor — an FK can't express that
//     condition, since debtors.contact_id itself is ON DELETE SET NULL.
export async function DELETE(_req: NextRequest, ctx: RouteCtx) {
  try {
    await requirePermission('contacts', 'edit');
  } catch (err) {
    const r = authErrorResponse(err);
    if (r) return r;
    throw err;
  }

  const { id } = await ctx.params;
  try {
    const ok = await deleteContact(id);
    if (!ok) return NextResponse.json({ error: 'not_found' }, { status: 404 });
    return new NextResponse(null, { status: 204 });
  } catch (err) {
    const e = err as { code?: string; constraint?: string; message?: string };
    if (e.code === ACTIVE_DEBT_DELETE_BLOCKED_SQLSTATE) {
      // Message is authored in the trigger itself (migration 20260921072925)
      // and already includes the apartment number — forwarded verbatim so it
      // can't drift out of sync with a hardcoded copy here.
      return NextResponse.json({ error: e.message ?? 'לא ניתן למחוק — קיים חוב פעיל לדירה זו' }, { status: 409 });
    }
    if (e.code === '23503' && e.constraint === 'wa_campaign_recipients_contact_id_fkey') {
      return NextResponse.json(
        { error: 'לא ניתן למחוק את הדירה — נשלחו אליה תפוצות WhatsApp בעבר' },
        { status: 409 },
      );
    }
    if (e.code === '23503') {
      return NextResponse.json({ error: 'invalid_reference' }, { status: 400 });
    }
    logger.error('[DELETE /api/contacts/:id]', err);
    return NextResponse.json({ error: 'server_error' }, { status: 500 });
  }
}
