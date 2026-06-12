import { NextResponse, type NextRequest } from 'next/server';
import { requirePermission } from '@/lib/auth/actor';
import { authErrorResponse } from '@/lib/auth/apiGuard';
import { searchDebtors } from '@/lib/db/debtors';

export const runtime = 'nodejs';

// GET /api/debtors/search?q=… — lightweight lookup for the "link inbound message
// to debtor" dialog (apartment / owner / tenant name). Gated on whatsapp:edit —
// only used by the linking flow. Returns [] for queries shorter than 2 chars.
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

  const results = await searchDebtors(q);
  return NextResponse.json(results);
}
