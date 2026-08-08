import { NextResponse } from 'next/server';
import { requirePermission } from '@/lib/auth/actor';
import { authErrorResponse } from '@/lib/auth/apiGuard';
import { getChipsKpis } from '@/lib/db/chips';

export const runtime = 'nodejs';

// GET /api/chips/kpis (chips:view)
export async function GET() {
  try {
    await requirePermission('chips', 'view');
  } catch (err) {
    const r = authErrorResponse(err);
    if (r) return r;
    throw err;
  }

  const kpis = await getChipsKpis();
  return NextResponse.json({ kpis });
}
