import { NextResponse, type NextRequest } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { getDebtorById, updateDebtorFields } from '@/lib/db/debtors';
import { listCommentsByDebtor } from '@/lib/db/comments';
import { validatePhone, isFutureDate } from '@/lib/validation';
import type { TenantFieldsUpdate } from '@/types/tenant';

export const runtime = 'nodejs';

interface RouteCtx {
  params: Promise<{ id: string }>;
}

export async function GET(_req: NextRequest, ctx: RouteCtx) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });

  const { id } = await ctx.params;
  const tenant = await getDebtorById(id);
  if (!tenant) return NextResponse.json({ error: 'not_found' }, { status: 404 });

  const recent_notes = await listCommentsByDebtor(id, 3);
  return NextResponse.json({ tenant, recent_notes });
}

export async function PATCH(req: NextRequest, ctx: RouteCtx) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  if (!session.user.is_admin) {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 });
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
  const warnings: string[] = [];

  if ('phone_owner' in body) {
    const raw = body.phone_owner;
    if (raw == null || raw === '') {
      patch.phone_owner = null;
    } else {
      const v = validatePhone(raw);
      if (!v.valid) {
        return NextResponse.json({ error: v.error || 'invalid_phone_owner' }, { status: 400 });
      }
      patch.phone_owner = v.normalized;
    }
    patch.phones_manual_override = true;
  }
  if ('phone_tenant' in body) {
    const raw = body.phone_tenant;
    if (raw == null || raw === '') {
      patch.phone_tenant = null;
    } else {
      const v = validatePhone(raw);
      if (!v.valid) {
        return NextResponse.json({ error: v.error || 'invalid_phone_tenant' }, { status: 400 });
      }
      patch.phone_tenant = v.normalized;
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

  await updateDebtorFields(id, patch);
  const tenant = await getDebtorById(id);
  return NextResponse.json({ tenant, warnings });
}
