import { NextResponse } from 'next/server';
import { requirePurchasingAny } from '@/lib/auth/purchasingGuard';
import { authErrorResponse } from '@/lib/auth/apiGuard';
import { countRfqsWithUnseenQuotes } from '@/lib/db/purchasing';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// GET /api/purchasing/unseen → { count } — requests holding a portal quote nobody
// has opened yet. The poll target of the menu badge and the dashboard card.
export async function GET() {
  try { await requirePurchasingAny('view'); }
  catch (err) { const r = authErrorResponse(err); if (r) return r; throw err; }
  return NextResponse.json({ count: await countRfqsWithUnseenQuotes() }, { headers: { 'Cache-Control': 'no-store' } });
}
