import { NextResponse, type NextRequest } from 'next/server';
import { requirePermission, type Actor } from '@/lib/auth/actor';
import { authErrorResponse } from '@/lib/auth/apiGuard';
import { listSuppliers, createSupplier } from '@/lib/db/suppliers';
import { coerceAndValidateSupplier } from '@/lib/validation/suppliers';
import type { SupplierStatus } from '@/lib/types/suppliers';

export const runtime = 'nodejs';

const STATUSES: readonly SupplierStatus[] = ['active', 'inactive', 'archived'];

// GET /api/suppliers?search&status&type&category (suppliers:view)
export async function GET(req: NextRequest) {
  try {
    await requirePermission('suppliers', 'view');
  } catch (err) {
    const r = authErrorResponse(err);
    if (r) return r;
    throw err;
  }

  const sp = req.nextUrl.searchParams;
  const search = sp.get('search')?.trim() || undefined;

  const statusRaw = sp.get('status')?.trim();
  const status =
    statusRaw && statusRaw !== 'all' && STATUSES.includes(statusRaw as SupplierStatus)
      ? (statusRaw as SupplierStatus)
      : undefined;

  const typeRaw = sp.get('type')?.trim();
  const type = typeRaw && typeRaw !== 'all' ? typeRaw : undefined;

  const categoryRaw = sp.get('category')?.trim();
  const category = categoryRaw && categoryRaw !== 'all' ? categoryRaw : undefined;

  const suppliers = await listSuppliers({ search, status, type, category });
  return NextResponse.json({ suppliers });
}

// POST /api/suppliers (suppliers:edit)
export async function POST(req: NextRequest) {
  let actor: Actor;
  try {
    actor = await requirePermission('suppliers', 'edit');
  } catch (err) {
    const r = authErrorResponse(err);
    if (r) return r;
    throw err;
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'invalid_json' }, { status: 400 });
  }

  const result = coerceAndValidateSupplier((body ?? {}) as Record<string, unknown>);
  if (!result.ok) {
    return NextResponse.json({ error: result.error }, { status: 400 });
  }

  try {
    const id = await createSupplier(result.fields, actor.id, actor.full_name ?? actor.username);
    return NextResponse.json({ id }, { status: 201 });
  } catch (err) {
    const e = err as { code?: string };
    if (e.code === '23503') {
      return NextResponse.json({ error: 'invalid_category' }, { status: 400 });
    }
    console.error('[POST /api/suppliers]', err);
    return NextResponse.json({ error: 'server_error' }, { status: 500 });
  }
}
