import { NextResponse, type NextRequest } from 'next/server';
import { requirePermission } from '@/lib/auth/actor';
import { authErrorResponse } from '@/lib/auth/apiGuard';
import { setConversationLink } from '@/lib/db/chatMessages';
import { getDebtorApartmentNumber } from '@/lib/db/debtors';
import { supplierExists } from '@/lib/db/suppliers';

export const runtime = 'nodejs';

interface RouteCtx {
  params: Promise<{ id: string }>;
}

interface PostBody {
  debtor_id?: unknown;
  supplier_id?: unknown;
  unlink?: unknown;
}

// POST /api/whatsapp/messages/[id]/link — set a conversation's link target. One
// of three intents (mutually exclusive — the conversation links to a debtor OR a
// supplier OR neither):
//   { debtor_id }    → attach to a debtor (apartment); clears any supplier link
//   { supplier_id }  → attach to a supplier;          clears any debtor link
//   { unlink: true } → detach (back to unlinked)
// Every message sharing the conversation's chat_id is updated. Gated on
// whatsapp:edit. Returns { ok, linked } or 404 if the message id is unknown.
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
  const supplierId = typeof body.supplier_id === 'string' ? body.supplier_id.trim() : '';
  const unlink = body.unlink === true;

  // Exactly one intent.
  const intents = [debtorId ? 'debtor' : null, supplierId ? 'supplier' : null, unlink ? 'unlink' : null].filter(
    Boolean,
  );
  if (intents.length !== 1) {
    return NextResponse.json({ error: 'יש לבחור שיוך אחד בלבד' }, { status: 400 });
  }

  // Validate the target exists for a clean error (instead of an FK violation).
  if (debtorId) {
    const apartment = await getDebtorApartmentNumber(debtorId);
    if (!apartment) {
      return NextResponse.json({ error: 'החייב לא נמצא' }, { status: 404 });
    }
  } else if (supplierId) {
    if (!(await supplierExists(supplierId))) {
      return NextResponse.json({ error: 'הספק לא נמצא' }, { status: 404 });
    }
  }

  const linked = await setConversationLink(id, {
    debtorId: debtorId || null,
    supplierId: supplierId || null,
  });
  if (linked === null) {
    return NextResponse.json({ error: 'ההודעה לא נמצאה' }, { status: 404 });
  }

  return NextResponse.json({ ok: true, linked });
}
