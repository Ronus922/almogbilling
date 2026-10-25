import { NextResponse, type NextRequest } from 'next/server';
import { type Actor } from '@/lib/auth/actor';
import { denyPurchasingType, requirePurchasingAny } from '@/lib/auth/purchasingGuard';
import { authErrorResponse } from '@/lib/auth/apiGuard';
import { parseJsonBody } from '@/lib/http/body';
import { writeAudit } from '@/lib/db/audit';
import { findDocument, listRecipients } from '@/lib/db/purchasing';
import { sendBodySchema } from '@/lib/validation/purchasing';
import { CompanyMissingError, DraftDocumentError, sendDocument } from '@/lib/purchasing/service';
import { isRfqOpen, MANUAL_PARTY, partyKey } from '@/lib/purchasing/model';
import { logger } from '@/lib/logger';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// POST /api/purchasing/documents/[id]/send — { supplier_ids (uuid | 'manual' | key), email, whatsapp }.
// A purchase order goes to its own supplier only (listed or hand-typed); a request to its
// recipients (chosen on its form), each with a personal link. Per-recipient failures are reported in
// `results` (HTTP 200), never thrown.
export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  let actor: Actor;
  try { actor = await requirePurchasingAny('edit'); }
  catch (err) { const r = authErrorResponse(err); if (r) return r; throw err; }
  const { id } = await ctx.params;
  if (!UUID.test(id)) return NextResponse.json({ error: 'not_found' }, { status: 404 });
  const body = await parseJsonBody(req, sendBodySchema);
  if (!body.ok) return body.response;

  const doc = await findDocument(id);
  if (!doc) return NextResponse.json({ error: 'not_found' }, { status: 404 });
  const denied = denyPurchasingType(actor, doc.doc_type, 'edit');
  if (denied) return denied;
  if (doc.status === 'draft') {
    return NextResponse.json({ error: 'אי אפשר לשלוח טיוטה — יש להפיק את המסמך קודם' }, { status: 409 });
  }
  // The hand-typed supplier of an order is the document's own (never a free-floating party).
  const own = doc.supplier_id ?? MANUAL_PARTY;
  if (doc.doc_type === 'po') {
    if (body.data.supplier_ids.includes(MANUAL_PARTY) && (doc.supplier_id !== null || !doc.supplier_name)) {
      return NextResponse.json({ error: 'אין למסמך ספק שהוקלד ידנית' }, { status: 400 });
    }
    if (body.data.supplier_ids.length !== 1 || body.data.supplier_ids[0] !== own) {
      return NextResponse.json({ error: 'הזמנת רכש נשלחת לספק שלה בלבד' }, { status: 400 });
    }
  } else {
    // A request goes only to the suppliers chosen on its own form.
    const known = new Set((await listRecipients(id)).map((r) => partyKey(r)));
    if (body.data.supplier_ids.some((k) => !known.has(k))) {
      return NextResponse.json({ error: 'הספק אינו ברשימת הספקים של הבקשה' }, { status: 400 });
    }
  }
  if (doc.doc_type === 'rfq' && doc.due_date && !isRfqOpen(doc.due_date)) {
    return NextResponse.json({ error: 'תאריך היעד להגשה עבר — יש להאריך אותו לפני שליחה' }, { status: 409 });
  }

  try {
    const results = await sendDocument(actor, id, [...new Set(body.data.supplier_ids)], {
      email: body.data.email, whatsapp: body.data.whatsapp,
    });
    const sent = results.filter((r) => r.ok).length;
    const skipped = results.filter((r) => r.skipped).length;
    const failed = results.length - sent - skipped;
    await writeAudit({
      actorUserId: actor.id, action: 'sent', entityType: 'purchasing_document', entityId: id,
      changes: { after: { sent, failed, skipped, channels: { email: body.data.email, whatsapp: body.data.whatsapp } } },
    });
    // Per-recipient outcomes (a missing e-mail / phone included) are DATA, not a
    // server failure: always 200, the screen reads `failed_count` and `results`.
    return NextResponse.json({ results, sent_count: sent, failed_count: failed, skipped_count: skipped });
  } catch (err) {
    if (err instanceof DraftDocumentError) return NextResponse.json({ error: 'אי אפשר לשלוח טיוטה — יש להפיק את המסמך קודם' }, { status: 409 });
    if (err instanceof CompanyMissingError) return NextResponse.json({ error: 'company_missing' }, { status: 409 });
    logger.error('[POST /api/purchasing/documents/send] failed', err);
    return NextResponse.json({ error: 'השליחה נכשלה' }, { status: 500 });
  }
}
