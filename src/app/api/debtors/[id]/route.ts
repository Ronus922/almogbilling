import { NextResponse, type NextRequest } from 'next/server';
import { requirePermission, requireAnyPermission } from '@/lib/auth/actor';
import { authErrorResponse } from '@/lib/auth/apiGuard';
import { getDebtorById, updateDebtorFields } from '@/lib/db/debtors';
import { updateContactPhonesByDebtor } from '@/lib/db/contacts';
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
  return NextResponse.json({ tenant, recent_notes });
}

export async function PATCH(req: NextRequest, ctx: RouteCtx) {
  try {
    await requirePermission('contacts', 'edit');
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
    const r = await updateContactPhonesByDebtor(id, contactPhones);
    if (r === 'no_contact') return NextResponse.json({ error: 'not_found' }, { status: 404 });
  }
  await updateDebtorFields(id, patch);
  const tenant = await getDebtorById(id);
  return NextResponse.json({ tenant, warnings });
}
