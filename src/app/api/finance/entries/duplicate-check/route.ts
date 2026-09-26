import { NextResponse, type NextRequest } from 'next/server';
import { requirePermission } from '@/lib/auth/actor';
import { authErrorResponse } from '@/lib/auth/apiGuard';
import { findDuplicateExpense } from '@/lib/db/finance/entries';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// GET /api/finance/entries/duplicate-check?invoice=&supplier_id=&supplier_name=&exclude=
// A WARNING for the expense sheet ("same supplier + same invoice number already
// exists") — never a block. Returns { duplicate: null | {...} }.
export async function GET(req: NextRequest) {
  try { await requirePermission('finance', 'view'); }
  catch (err) { const r = authErrorResponse(err); if (r) return r; throw err; }

  const sp = req.nextUrl.searchParams;
  const supplierId = sp.get('supplier_id');
  const exclude = sp.get('exclude');
  const duplicate = await findDuplicateExpense({
    invoiceNumber: sp.get('invoice') ?? '',
    supplierId: supplierId && UUID_RE.test(supplierId) ? supplierId : null,
    supplierName: sp.get('supplier_name') ?? '',
    excludeId: exclude && UUID_RE.test(exclude) ? exclude : null,
  });
  return NextResponse.json({ duplicate });
}
