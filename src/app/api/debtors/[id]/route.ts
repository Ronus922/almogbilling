import { NextResponse, type NextRequest } from 'next/server';
import { requirePermission, requireAnyPermission, type Actor } from '@/lib/auth/actor';
import { authErrorResponse } from '@/lib/auth/apiGuard';
import { getDebtorById, updateDebtorFields } from '@/lib/db/debtors';
import { debtorContactApartment, updateContactPhonesByDebtor } from '@/lib/db/contacts';
import { withTransaction } from '@/lib/db';
import { logger } from '@/lib/logger';
import { phoneEntryErrorResponse, readPhoneDecisions, withPhoneEntryCheck } from '@/lib/http/phoneEntry';
import { getContactFieldState } from '@/lib/db/contactSuggestions';
import { listCommentsByDebtor } from '@/lib/db/comments';
import { validatePhone, isFutureDate } from '@/lib/validation';
import type { TenantFieldsUpdate } from '@/types/tenant';

export const runtime = 'nodejs';

interface RouteCtx {
  params: Promise<{ id: string }>;
}

export async function GET(_req: NextRequest, ctx: RouteCtx) {
  try {
    // Debtors screen read — granted by `dashboard` (viewer) OR `contacts` (manager).
    await requireAnyPermission([
      { module: 'dashboard', action: 'view' },
      { module: 'contacts', action: 'view' },
    ]);
  } catch (err) {
    const r = authErrorResponse(err);
    if (r) return r;
    throw err;
  }

  const { id } = await ctx.params;
  const tenant = await getDebtorById(id);
  if (!tenant) return NextResponse.json({ error: 'not_found' }, { status: 404 });

  const recent_notes = await listCommentsByDebtor(id, 3);
  // The card's two decorations on the resident fields: open Bllink suggestions
  // and who last changed each field. Read here so the panel needs no second
  // round trip on open.
  const contact_fields = await getContactFieldState(tenant.apartment_number);
  return NextResponse.json({ tenant, recent_notes, contact_fields });
}

// PATCH — the phones go to the apartment's contact record, under the SAME
// entry warning as the apartment card (lib/http/phoneEntry.ts): a phone that
// another apartment carries under another name answers 409 phone_conflict and
// nothing — phones or any other field — is saved; the panel asks "אותו אדם?"
// and sends the edit again with `phone_decisions`.
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
  const existing = await getDebtorById(id);
  if (!existing) return NextResponse.json({ error: 'not_found' }, { status: 404 });

  let body: TenantFieldsUpdate;
  try {
    body = (await req.json()) as TenantFieldsUpdate;
  } catch {
    return NextResponse.json({ error: 'invalid_json' }, { status: 400 });
  }
  const decisions = readPhoneDecisions((body ?? {}) as Record<string, unknown>);
  if (!decisions.ok) {
    return NextResponse.json({ error: 'invalid_phone_decisions' }, { status: 400 });
  }

  const patch: Record<string, unknown> = {};
  // Phones are written to the contacts registry (source of truth) — the debtors
  // phone columns are frozen legacy. Only the informational override flag stays.
  const contactPhones: { owner_phone?: string | null; tenant_phone?: string | null } = {};
  const warnings: string[] = [];

  if ('phone_owner' in body) {
    const raw = body.phone_owner;
    if (raw == null || raw === '') {
      contactPhones.owner_phone = null;
    } else {
      const v = validatePhone(raw);
      if (!v.valid) {
        return NextResponse.json({ error: v.error || 'invalid_phone_owner' }, { status: 400 });
      }
      contactPhones.owner_phone = v.normalized;
    }
    patch.phones_manual_override = true;
  }
  if ('phone_tenant' in body) {
    const raw = body.phone_tenant;
    if (raw == null || raw === '') {
      contactPhones.tenant_phone = null;
    } else {
      const v = validatePhone(raw);
      if (!v.valid) {
        return NextResponse.json({ error: v.error || 'invalid_phone_tenant' }, { status: 400 });
      }
      contactPhones.tenant_phone = v.normalized;
    }
    patch.phones_manual_override = true;
  }
  if ('notes' in body) {
    patch.notes = body.notes ?? null;
  }
  if ('next_action_description' in body) {
    patch.next_action_description = body.next_action_description ?? null;
  }
  if ('next_action_date' in body) {
    const d = body.next_action_date ?? null;
    patch.next_action_date = d;
    if (d && !isFutureDate(d)) {
      warnings.push('next_action_date_in_past');
    }
  }
  if ('last_contact_date' in body) {
    const d = body.last_contact_date ?? null;
    if (d && isFutureDate(d)) {
      return NextResponse.json({ error: 'last_contact_date_future' }, { status: 400 });
    }
    patch.last_contact_date = d;
  }

  if (Object.keys(contactPhones).length > 0) {
    try {
      const r = await withTransaction(async (client) => {
        const apartment = await debtorContactApartment(client, id);
        return withPhoneEntryCheck(
          client,
          { apartments: apartment ? [apartment] : [], decisions: decisions.decisions, actor },
          async () => {
            const w = await updateContactPhonesByDebtor(id, contactPhones, client);
            return { result: w, apartments: w === 'no_contact' ? [] : [w.apartment] };
          },
        );
      });
      if (r === 'no_contact') return NextResponse.json({ error: 'not_found' }, { status: 404 });
    } catch (err) {
      const warn = phoneEntryErrorResponse(err, actor);
      if (warn) return warn;
      logger.error('[PATCH /api/debtors/:id] phones', err);
      return NextResponse.json({ error: 'server_error' }, { status: 500 });
    }
  }
  await updateDebtorFields(id, patch);
  const tenant = await getDebtorById(id);
  return NextResponse.json({ tenant, warnings });
}
