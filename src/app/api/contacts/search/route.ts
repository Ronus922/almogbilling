import { NextResponse, type NextRequest } from 'next/server';
import { requireAnyPermission } from '@/lib/auth/actor';
import { authErrorResponse } from '@/lib/auth/apiGuard';
import { searchContactsRegistry } from '@/lib/db/contacts';

export const runtime = 'nodejs';

// GET /api/contacts/search?q — lightweight registry lookup for the chip-issue
// contact picker. Served to a contacts viewer OR a chips manager (logical OR).
export async function GET(req: NextRequest) {
  try {
    await requireAnyPermission([
      { module: 'contacts', action: 'view' },
      { module: 'chips', action: 'edit' },
    ]);
  } catch (err) {
    const r = authErrorResponse(err);
    if (r) return r;
    throw err;
  }

  const q = req.nextUrl.searchParams.get('q')?.trim() ?? '';
  if (q.length < 1) {
    return NextResponse.json({ items: [] });
  }

  const items = await searchContactsRegistry(q);
  return NextResponse.json({ items });
}
