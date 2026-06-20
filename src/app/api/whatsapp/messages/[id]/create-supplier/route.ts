import { NextResponse, type NextRequest } from 'next/server';
import { requirePermission, type Actor } from '@/lib/auth/actor';
import { authErrorResponse } from '@/lib/auth/apiGuard';
import { getMessageContactPhone, setConversationLink } from '@/lib/db/chatMessages';
import { createSupplier } from '@/lib/db/suppliers';
import { coerceAndValidateSupplier } from '@/lib/validation/suppliers';
import { writeAudit } from '@/lib/db/audit';

export const runtime = 'nodejs';

interface RouteCtx {
  params: Promise<{ id: string }>;
}

interface PostBody {
  display_name?: unknown;
  category_id?: unknown;
}

// POST /api/whatsapp/messages/[id]/create-supplier — create a minimal supplier
// FROM the conversation's number, then link the whole conversation to it. Two
// permissions are required: creating the supplier needs suppliers:edit, linking
// the conversation needs whatsapp:edit. The phone is taken server-side from the
// conversation's contact_phone (cleaned to one canonical local number) and stored
// as the supplier's mobile — so the inbound cross-reference recognises that number
// as this supplier from now on. All other supplier fields default to empty; the
// rest is filled later in /suppliers. Body: { display_name (required), category_id? }.
export async function POST(req: NextRequest, ctx: RouteCtx) {
  let actor: Actor;
  try {
    actor = await requirePermission('suppliers', 'edit'); // create the supplier
    await requirePermission('whatsapp', 'edit'); // link the conversation
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

  // The number is the source of truth from the conversation — never trusted from
  // the client. Cleaned by the supplier validator (cleanPhoneField).
  const contactPhone = await getMessageContactPhone(id);
  if (!contactPhone) {
    return NextResponse.json({ error: 'ההודעה לא נמצאה' }, { status: 404 });
  }

  const result = coerceAndValidateSupplier({
    display_name: body.display_name,
    category_id: body.category_id,
    mobile: contactPhone,
  });
  if (!result.ok) {
    return NextResponse.json({ error: result.error }, { status: 400 });
  }

  try {
    const supplierId = await createSupplier(result.fields, actor.id, actor.full_name ?? actor.username);
    await writeAudit({
      actorUserId: actor.id,
      action: 'created',
      entityType: 'supplier',
      entityId: supplierId,
      metadata: { display_name: result.fields.display_name, source: 'whatsapp_chat' },
    });

    const linked = await setConversationLink(id, { supplierId });
    return NextResponse.json({ id: supplierId, linked: linked ?? 0 }, { status: 201 });
  } catch (err) {
    const e = err as { code?: string };
    if (e.code === '23503') {
      return NextResponse.json({ error: 'invalid_category' }, { status: 400 });
    }
    console.error('[POST /api/whatsapp/messages/[id]/create-supplier]', err);
    return NextResponse.json({ error: 'server_error' }, { status: 500 });
  }
}
