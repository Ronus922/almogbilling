import { NextResponse, type NextRequest } from 'next/server';
import { requirePermission } from '@/lib/auth/actor';
import { authErrorResponse } from '@/lib/auth/apiGuard';
import {
  getSupplierCategoryById,
  findSupplierCategoryByLowerName,
  updateSupplierCategory,
  countLinkedSuppliersInCategory,
  deleteSupplierCategory,
} from '@/lib/db/supplierCategories';
import {
  validateSupplierCategoryForm,
  canDeleteSupplierCategory,
} from '@/lib/validation/suppliers';

export const runtime = 'nodejs';

interface RouteCtx {
  params: Promise<{ id: string }>;
}

// PATCH /api/suppliers/categories/[id] (suppliers:edit) — rename and/or toggle active.
export async function PATCH(req: NextRequest, ctx: RouteCtx) {
  try {
    await requirePermission('suppliers', 'edit');
  } catch (err) {
    const r = authErrorResponse(err);
    if (r) return r;
    throw err;
  }

  const { id } = await ctx.params;
  const existing = await getSupplierCategoryById(id);
  if (!existing) {
    return NextResponse.json({ error: 'not_found' }, { status: 404 });
  }

  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: 'invalid_json' }, { status: 400 });
  }

  const patch: { name?: string; is_active?: boolean } = {};

  if ('name' in body) {
    const result = validateSupplierCategoryForm({ name: body.name });
    if (!result.ok) {
      return NextResponse.json({ error: 'validation', errors: result.errors }, { status: 400 });
    }
    const clash = await findSupplierCategoryByLowerName(result.value.name, id);
    if (clash) {
      return NextResponse.json(
        { error: 'name_taken', message: 'קטגוריה בשם זה כבר קיימת', field: 'name' },
        { status: 409 },
      );
    }
    patch.name = result.value.name;
  }

  if ('is_active' in body) {
    patch.is_active = body.is_active === true;
  }

  try {
    const updated = await updateSupplierCategory(id, patch);
    if (!updated) return NextResponse.json({ error: 'not_found' }, { status: 404 });
    return NextResponse.json(updated);
  } catch (err) {
    const e = err as { code?: string };
    if (e.code === '23505') {
      return NextResponse.json(
        { error: 'name_taken', message: 'קטגוריה בשם זה כבר קיימת', field: 'name' },
        { status: 409 },
      );
    }
    console.error('[PATCH /api/suppliers/categories/:id]', err);
    return NextResponse.json({ error: 'server_error' }, { status: 500 });
  }
}

// DELETE /api/suppliers/categories/[id] (suppliers:edit) — hard delete, blocked
// while live suppliers are still assigned (mirrors the status-deletion guard).
export async function DELETE(_req: NextRequest, ctx: RouteCtx) {
  try {
    await requirePermission('suppliers', 'edit');
  } catch (err) {
    const r = authErrorResponse(err);
    if (r) return r;
    throw err;
  }

  const { id } = await ctx.params;
  const existing = await getSupplierCategoryById(id);
  if (!existing) {
    return NextResponse.json({ error: 'not_found' }, { status: 404 });
  }

  const linked = await countLinkedSuppliersInCategory(id);
  if (!canDeleteSupplierCategory(linked)) {
    return NextResponse.json(
      { error: 'has_linked', message: 'הקטגוריה משויכת לספקים', linked_count: linked },
      { status: 409 },
    );
  }

  try {
    await deleteSupplierCategory(id);
    return NextResponse.json({ ok: true });
  } catch (err) {
    console.error('[DELETE /api/suppliers/categories/:id]', err);
    return NextResponse.json({ error: 'server_error' }, { status: 500 });
  }
}
