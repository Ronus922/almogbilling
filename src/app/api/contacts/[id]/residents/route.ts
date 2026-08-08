import { NextResponse, type NextRequest } from 'next/server';
import { requirePermission } from '@/lib/auth/actor';
import { authErrorResponse } from '@/lib/auth/apiGuard';
import { getContactResidents } from '@/lib/db/contacts';

export const runtime = 'nodejs';

interface RouteCtx {
  params: Promise<{ id: string }>;
}

// GET /api/contacts/[id]/residents (chips:view) — the contact's three inline
// resident slots (owner/tenant/operator) as cards for the chip-issue panel.
export async function GET(_req: NextRequest, ctx: RouteCtx) {
  try {
    await requirePermission('chips', 'view');
  } catch (err) {
    const r = authErrorResponse(err);
    if (r) return r;
    throw err;
  }

  const { id } = await ctx.params;
  const residents = await getContactResidents(id);
  if (!residents) {
    return NextResponse.json({ error: 'not_found' }, { status: 404 });
  }
  return NextResponse.json(residents);
}
