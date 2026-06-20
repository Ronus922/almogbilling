import { NextResponse, type NextRequest } from 'next/server';
import { requirePermission } from '@/lib/auth/actor';
import { authErrorResponse } from '@/lib/auth/apiGuard';
import { searchSuppliers } from '@/lib/db/suppliers';

export const runtime = 'nodejs';

// GET /api/suppliers/search?q=… — lightweight lookup for the "link WhatsApp
// conversation to a supplier" dialog. Gated on whatsapp:edit (NOT suppliers:view)
// so the linking flow works without supplier-read access — mirrors
// /api/debtors/search. Returns [] for queries shorter than 2 chars.
export async function GET(req: NextRequest) {
  try {
    await requirePermission('whatsapp', 'edit');
  } catch (err) {
    const r = authErrorResponse(err);
    if (r) return r;
    throw err;
  }

  const q = req.nextUrl.searchParams.get('q')?.trim() ?? '';
  if (q.length < 2) return NextResponse.json([]);

  const results = await searchSuppliers(q);
  return NextResponse.json(results);
}
