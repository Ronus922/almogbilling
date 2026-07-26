import { NextResponse, type NextRequest } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { requirePermission } from '@/lib/auth/actor';
import { authErrorResponse } from '@/lib/auth/apiGuard';
import { getContactById, updateContact, deleteContact } from '@/lib/db/contacts';
import { replaceContactPeople } from '@/lib/db/contactPeople';
import { coerceContactInput, coerceContactPeople } from '@/lib/validation/contacts';
import { getBillingSettings } from '@/lib/db/appSettings';
import { computeManagementFee } from '@/lib/billing/managementFee';

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
export async function PATCH(req: NextRequest, ctx: RouteCtx) {
  try {
    await requirePermission('contacts', 'edit');
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
    const updated = await updateContact(id, result.fields);
    if (!updated) return NextResponse.json({ error: 'not_found' }, { status: 404 });
    if (peopleResult) await replaceContactPeople(id, peopleResult.people);
    const contact = peopleResult ? (await getContactById(id)) ?? updated : updated;
    return NextResponse.json({ contact });
  } catch (err) {
    const e = err as { code?: string };
    if (e.code === '23503') {
      return NextResponse.json({ error: 'invalid_reference' }, { status: 400 });
    }
    console.error('[PATCH /api/contacts/:id]', err);
    return NextResponse.json({ error: 'server_error' }, { status: 500 });
  }
}

// DELETE /api/contacts/[id] — contacts:edit. debtors.contact_id resets via FK ON DELETE SET NULL.
export async function DELETE(_req: NextRequest, ctx: RouteCtx) {
  try {
    await requirePermission('contacts', 'edit');
  } catch (err) {
    const r = authErrorResponse(err);
    if (r) return r;
    throw err;
  }

  const { id } = await ctx.params;
  const ok = await deleteContact(id);
  if (!ok) return NextResponse.json({ error: 'not_found' }, { status: 404 });
  return new NextResponse(null, { status: 204 });
}
