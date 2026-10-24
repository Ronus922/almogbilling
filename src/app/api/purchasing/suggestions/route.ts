import { NextResponse, type NextRequest } from 'next/server';
import { requirePurchasingAny } from '@/lib/auth/purchasingGuard';
import { authErrorResponse } from '@/lib/auth/apiGuard';
import { suggestDescriptions } from '@/lib/db/purchasing';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// GET /api/purchasing/suggestions?q= — previously entered line descriptions
// (most used first) for the "פירוט" autocomplete.
export async function GET(req: NextRequest) {
  try { await requirePurchasingAny('view'); }
  catch (err) { const r = authErrorResponse(err); if (r) return r; throw err; }
  const q = (req.nextUrl.searchParams.get('q') ?? '').slice(0, 100);
  return NextResponse.json({ suggestions: await suggestDescriptions(q) });
}
