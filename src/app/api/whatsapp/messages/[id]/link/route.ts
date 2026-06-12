import { NextResponse, type NextRequest } from 'next/server';
import { requirePermission } from '@/lib/auth/actor';
import { authErrorResponse } from '@/lib/auth/apiGuard';
import { linkMessagesToDebtor } from '@/lib/db/chatMessages';
import { getDebtorApartmentNumber } from '@/lib/db/debtors';

export const runtime = 'nodejs';

interface RouteCtx {
  params: Promise<{ id: string }>;
}

interface PostBody {
  debtor_id?: unknown;
}

// POST /api/whatsapp/messages/[id]/link — attach an unlinked inbound message
// (and every other unlinked message from the same number) to a debtor.
// Gated on whatsapp:edit. Returns { ok, linked } or 404 if already linked/unknown.
export async function POST(req: NextRequest, ctx: RouteCtx) {
  try {
    await requirePermission('whatsapp', 'edit');
  } catch (err) {
    const r = authErrorResponse(err);
    if (r) return r;
    throw err;
  }

  const { id } = await ctx.params;

  let body: PostBody;
  try {
    body = (await req.json()) as PostBody;
  } catch {
    return NextResponse.json({ error: 'invalid_json' }, { status: 400 });
  }

  const debtorId = typeof body.debtor_id === 'string' ? body.debtor_id.trim() : '';
  if (!debtorId) {
    return NextResponse.json({ error: 'יש לבחור חייב' }, { status: 400 });
  }

  // Validate the debtor exists for a clean error (instead of an FK violation).
  const apartment = await getDebtorApartmentNumber(debtorId);
  if (!apartment) {
    return NextResponse.json({ error: 'החייב לא נמצא' }, { status: 404 });
  }

  const linked = await linkMessagesToDebtor(id, debtorId);
  if (linked === null) {
    return NextResponse.json({ error: 'ההודעה לא נמצאה או כבר שויכה' }, { status: 404 });
  }

  return NextResponse.json({ ok: true, linked });
}
