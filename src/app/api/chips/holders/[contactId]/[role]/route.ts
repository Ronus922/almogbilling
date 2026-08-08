import { NextResponse, type NextRequest } from 'next/server';
import { requirePermission } from '@/lib/auth/actor';
import { authErrorResponse } from '@/lib/auth/apiGuard';
import { getChipsByHolder } from '@/lib/db/chips';
import { CHIP_RESIDENT_ROLES } from '@/lib/constants/chips';
import type { ChipResidentRole } from '@/lib/types/chips';

export const runtime = 'nodejs';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// GET /api/chips/holders/[contactId]/[role]?holder_name= (chips:view)
// All chips of ONE person — the "name → numbers" direction. Person identity is
// (contact_id, resident_role); snapshot roles (other/staff) narrow further by
// holder_name, since several such holders may share one apartment.
export async function GET(
  req: NextRequest,
  ctx: { params: Promise<{ contactId: string; role: string }> },
) {
  try {
    await requirePermission('chips', 'view');
  } catch (err) {
    const r = authErrorResponse(err);
    if (r) return r;
    throw err;
  }

  const { contactId, role } = await ctx.params;
  if (!UUID_RE.test(contactId)) {
    return NextResponse.json({ error: 'not_found' }, { status: 404 });
  }
  if (!CHIP_RESIDENT_ROLES.includes(role as ChipResidentRole)) {
    return NextResponse.json({ error: 'not_found' }, { status: 404 });
  }

  const holderName = req.nextUrl.searchParams.get('holder_name')?.trim() || null;
  const items = await getChipsByHolder(contactId, role as ChipResidentRole, holderName);
  return NextResponse.json({ items });
}
