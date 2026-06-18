import { NextResponse, type NextRequest } from 'next/server';
import { requirePermission } from '@/lib/auth/actor';
import { authErrorResponse } from '@/lib/auth/apiGuard';
import {
  listActiveVendorCategories,
  listVendorCategoriesWithCounts,
  findVendorCategoryByLowerName,
  createVendorCategory,
} from '@/lib/db/vendorCategories';
import { validateVendorCategoryForm } from '@/lib/validation/vendors';

export const runtime = 'nodejs';

// GET /api/vendors/categories (vendors:view)
//   default      → active categories (filter + form Select)
//   ?scope=all   → all categories with live-vendor counts (management sheet)
export async function GET(req: NextRequest) {
  try {
    await requirePermission('vendors', 'view');
  } catch (err) {
    const r = authErrorResponse(err);
    if (r) return r;
    throw err;
  }

  const scope = req.nextUrl.searchParams.get('scope');
  if (scope === 'all') {
    return NextResponse.json(await listVendorCategoriesWithCounts());
  }
  return NextResponse.json(await listActiveVendorCategories());
}

// POST /api/vendors/categories (vendors:edit)
export async function POST(req: NextRequest) {
  try {
    await requirePermission('vendors', 'edit');
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

  const result = validateVendorCategoryForm(body as Record<string, unknown>);
  if (!result.ok) {
    return NextResponse.json({ error: 'validation', errors: result.errors }, { status: 400 });
  }

  const clash = await findVendorCategoryByLowerName(result.value.name, null);
  if (clash) {
    return NextResponse.json(
      { error: 'name_taken', message: 'קטגוריה בשם זה כבר קיימת', field: 'name' },
      { status: 409 },
    );
  }

  try {
    const created = await createVendorCategory(result.value.name);
    return NextResponse.json(created, { status: 201 });
  } catch (err) {
    const e = err as { code?: string };
    if (e.code === '23505') {
      return NextResponse.json(
        { error: 'name_taken', message: 'קטגוריה בשם זה כבר קיימת', field: 'name' },
        { status: 409 },
      );
    }
    console.error('[POST /api/vendors/categories]', err);
    return NextResponse.json({ error: 'server_error' }, { status: 500 });
  }
}
