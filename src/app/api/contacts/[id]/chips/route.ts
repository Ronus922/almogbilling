import { NextResponse, type NextRequest } from 'next/server';
import { requirePermission } from '@/lib/auth/actor';
import { authErrorResponse } from '@/lib/auth/apiGuard';
import { getChipsByContact, countActiveChipsForContact } from '@/lib/db/chips';

export const runtime = 'nodejs';

interface RouteCtx {
  params: Promise<{ id: string }>;
}

// GET /api/contacts/[id]/chips (chips:view) — the contact's chips + how many
// are active (the issue panel shows the soft-limit meter from active_count).
export async function GET(_req: NextRequest, ctx: RouteCtx) {
  try {
    await requirePermission('chips', 'view');
  } catch (err) {
    const r = authErrorResponse(err);
    if (r) return r;
    throw err;
  }

  const { id } = await ctx.params;
  const [items, active_count] = await Promise.all([
    getChipsByContact(id),
    countActiveChipsForContact(id),
  ]);
  return NextResponse.json({ items, active_count });
}
