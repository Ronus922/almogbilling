import { NextResponse, type NextRequest } from 'next/server';
import { requirePermission } from '@/lib/auth/actor';
import { authErrorResponse } from '@/lib/auth/apiGuard';
import { setContactResidentType } from '@/lib/db/contacts';

export const runtime = 'nodejs';

interface RouteCtx {
  params: Promise<{ id: string }>;
}

const RESIDENT_TYPES = ['owner', 'tenant', 'operator'] as const;
type ResidentType = (typeof RESIDENT_TYPES)[number];

// PATCH /api/contacts/[id]/resident-type (chips:edit) — set who currently
// lives in the unit.
export async function PATCH(req: NextRequest, ctx: RouteCtx) {
  try {
    await requirePermission('chips', 'edit');
  } catch (err) {
    const r = authErrorResponse(err);
    if (r) return r;
    throw err;
  }

  const { id } = await ctx.params;

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'invalid_json' }, { status: 400 });
  }
  const bodyRec = (body ?? {}) as Record<string, unknown>;

  const raw = typeof bodyRec.resident_type === 'string' ? bodyRec.resident_type.trim() : '';
  if (!RESIDENT_TYPES.includes(raw as ResidentType)) {
    return NextResponse.json({ error: 'ערך לא חוקי' }, { status: 400 });
  }
  const resident_type = raw as ResidentType;

  const ok = await setContactResidentType(id, resident_type);
  if (!ok) {
    return NextResponse.json({ error: 'not_found' }, { status: 404 });
  }
  return NextResponse.json({ ok: true, resident_type });
}
