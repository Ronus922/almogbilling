import { NextResponse, type NextRequest } from 'next/server';
import { requirePermission, requireAdmin } from '@/lib/auth/actor';
import { authErrorResponse } from '@/lib/auth/apiGuard';
import { getSupplierById, updateSupplier, softDeleteSupplier } from '@/lib/db/suppliers';
import { validatePhone } from '@/lib/validation';
import type {
  SupplierStatus,
  SupplierPaymentTerms,
  SupplierWritableFields,
} from '@/lib/types/suppliers';

export const runtime = 'nodejs';

interface RouteCtx {
  params: Promise<{ id: string }>;
}

const STATUSES: readonly SupplierStatus[] = ['active', 'inactive', 'archived'];
const PAYMENT_TERMS: readonly SupplierPaymentTerms[] = [
  'immediate',
  'net_15',
  'net_30',
  'net_45',
  'net_60',
  'net_90',
  'other',
];

function str(v: unknown): string {
  return typeof v === 'string' ? v.trim() : '';
}

function coerceWritable(body: Record<string, unknown>): SupplierWritableFields {
  const statusRaw = str(body.status);
  const status: SupplierStatus = STATUSES.includes(statusRaw as SupplierStatus)
    ? (statusRaw as SupplierStatus)
    : 'active';

  const termsRaw = str(body.payment_terms);
  const payment_terms: SupplierPaymentTerms = PAYMENT_TERMS.includes(
    termsRaw as SupplierPaymentTerms,
  )
    ? (termsRaw as SupplierPaymentTerms)
    : 'immediate';

  const supplier_type = str(body.supplier_type) || 'general';

  let rating: number | null = null;
  if (typeof body.rating === 'number' && Number.isFinite(body.rating)) {
    rating = body.rating;
  }

  return {
    display_name: str(body.display_name),
    company_name: str(body.company_name),
    contact_person: str(body.contact_person),
    supplier_type,
    status,
    phone: str(body.phone),
    mobile: str(body.mobile),
    email: str(body.email),
    website: str(body.website),
    address: str(body.address),
    city: str(body.city),
    tax_id: str(body.tax_id),
    bank_name: str(body.bank_name),
    bank_branch: str(body.bank_branch),
    bank_account: str(body.bank_account),
    payment_terms,
    notes: str(body.notes),
    internal_notes: str(body.internal_notes),
    rating,
  };
}

function validateWritable(
  fields: SupplierWritableFields,
): { ok: true } | { ok: false; error: string } {
  if (!fields.display_name) return { ok: false, error: 'display_name_required' };
  if (fields.phone && !validatePhone(fields.phone).valid) {
    return { ok: false, error: 'invalid_phone' };
  }
  if (fields.mobile && !validatePhone(fields.mobile).valid) {
    return { ok: false, error: 'invalid_phone' };
  }
  return { ok: true };
}

// GET /api/suppliers/[id] (suppliers:view)
export async function GET(_req: NextRequest, ctx: RouteCtx) {
  try {
    await requirePermission('suppliers', 'view');
  } catch (err) {
    const r = authErrorResponse(err);
    if (r) return r;
    throw err;
  }

  const { id } = await ctx.params;
  const supplier = await getSupplierById(id);
  if (!supplier) {
    return NextResponse.json({ error: 'not_found' }, { status: 404 });
  }
  return NextResponse.json({ supplier });
}

// PATCH /api/suppliers/[id] (suppliers:edit) — whole-object save.
export async function PATCH(req: NextRequest, ctx: RouteCtx) {
  try {
    await requirePermission('suppliers', 'edit');
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

  const fields = coerceWritable((body ?? {}) as Record<string, unknown>);
  const v = validateWritable(fields);
  if (!v.ok) {
    return NextResponse.json({ error: v.error }, { status: 400 });
  }

  try {
    const ok = await updateSupplier(id, fields);
    if (!ok) {
      return NextResponse.json({ error: 'not_found' }, { status: 404 });
    }
    return NextResponse.json({ ok: true });
  } catch (err) {
    console.error('[PATCH /api/suppliers/:id]', err);
    return NextResponse.json({ error: 'server_error' }, { status: 500 });
  }
}

// DELETE /api/suppliers/[id] (admin) — soft delete.
export async function DELETE(_req: NextRequest, ctx: RouteCtx) {
  try {
    await requireAdmin();
  } catch (err) {
    const r = authErrorResponse(err);
    if (r) return r;
    throw err;
  }

  const { id } = await ctx.params;
  const ok = await softDeleteSupplier(id);
  if (!ok) {
    return NextResponse.json({ error: 'not_found' }, { status: 404 });
  }
  return NextResponse.json({ ok: true });
}
