import { NextResponse, type NextRequest } from 'next/server';
import { requirePermission, type Actor } from '@/lib/auth/actor';
import { authErrorResponse } from '@/lib/auth/apiGuard';
import { listVendors, createVendor } from '@/lib/db/vendors';
import { coerceAndValidateVendor } from '@/lib/validation/vendors';

export const runtime = 'nodejs';

// GET /api/vendors?search&category (vendors:view)
export async function GET(req: NextRequest) {
  try {
    await requirePermission('vendors', 'view');
  } catch (err) {
    const r = authErrorResponse(err);
    if (r) return r;
    throw err;
  }

  const sp = req.nextUrl.searchParams;
  const search = sp.get('search')?.trim() || undefined;
  const categoryRaw = sp.get('category')?.trim();
  const category = categoryRaw && categoryRaw !== 'all' ? categoryRaw : undefined;

  const vendors = await listVendors({ search, category });
  return NextResponse.json({ vendors });
}

// POST /api/vendors (vendors:edit)
export async function POST(req: NextRequest) {
  let actor: Actor;
  try {
    actor = await requirePermission('vendors', 'edit');
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

  const result = coerceAndValidateVendor((body ?? {}) as Record<string, unknown>);
  if (!result.ok) {
    return NextResponse.json({ error: result.error }, { status: 400 });
  }

  try {
    const id = await createVendor(result.fields, actor.id);
    return NextResponse.json({ id }, { status: 201 });
  } catch (err) {
    const e = err as { code?: string };
    if (e.code === '23503') {
      return NextResponse.json({ error: 'invalid_category' }, { status: 400 });
    }
    console.error('[POST /api/vendors]', err);
    return NextResponse.json({ error: 'server_error' }, { status: 500 });
  }
}
