import { NextResponse, type NextRequest } from 'next/server';
import { type Actor } from '@/lib/auth/actor';
import { requirePurchasingType } from '@/lib/auth/purchasingGuard';
import { authErrorResponse } from '@/lib/auth/apiGuard';
import { parseJsonBody } from '@/lib/http/body';
import { writeAudit } from '@/lib/db/audit';
import { ensureRecipient, findDocument, listRecipients, listSupplierBriefs } from '@/lib/db/purchasing';
import { addRecipientsBodySchema } from '@/lib/validation/purchasing';
import { isRfqOpen, partyKey } from '@/lib/purchasing/model';
import { quoteLink } from '@/lib/purchasing/service';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// POST /api/purchasing/documents/[id]/recipients — adds suppliers to an ISSUED request that is
// still open for quotes. { recipients: [{ supplier_id, key, name?, phone?, email? }] } (the item
// shape of the create body). A supplier already on the request is ignored (its link stays).
// Returns the request's whole recipients list, each with its party key and personal link; the
// screen then calls .../send with those keys.
export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  let actor: Actor;
  try { actor = await requirePurchasingType('rfq', 'edit'); }
  catch (err) { const r = authErrorResponse(err); if (r) return r; throw err; }
  const { id } = await ctx.params;
  if (!UUID.test(id)) return NextResponse.json({ error: 'not_found' }, { status: 404 });
  const body = await parseJsonBody(req, addRecipientsBodySchema);
  if (!body.ok) return body.response;

  const doc = await findDocument(id);
  if (!doc || doc.doc_type !== 'rfq') return NextResponse.json({ error: 'not_found' }, { status: 404 });
  if (doc.status !== 'issued') {
    return NextResponse.json({ error: 'אפשר להוסיף ספקים רק לבקשה שהופקה' }, { status: 409 });
  }
  if (!doc.due_date || !isRfqOpen(doc.due_date)) {
    return NextResponse.json({ error: 'הבקשה נעולה — תאריך היעד להגשה עבר' }, { status: 409 });
  }

  // Validate everything BEFORE the first write, so a bad item leaves the request untouched.
  const listedIds = body.data.recipients.flatMap((r) => (r.supplier_id ? [r.supplier_id] : []));
  if ((await listSupplierBriefs(listedIds)).length !== new Set(listedIds).size) {
    return NextResponse.json({ error: 'ספק לא נמצא' }, { status: 400 });
  }
  const existing = new Set((await listRecipients(id)).map((r) => partyKey(r)));
  const fresh = body.data.recipients.filter((r) => !existing.has((r.supplier_id ?? r.key) as string));
  if (existing.size + fresh.length > 30) {
    return NextResponse.json({ error: 'יותר מדי ספקים' }, { status: 400 });
  }

  for (const r of fresh) {
    if (r.supplier_id) await ensureRecipient(id, r.supplier_id);
    else {
      await ensureRecipient(id, null, {
        key: r.key as string, name: r.name as string, phone: r.phone, email: r.email, address: null,
      });
    }
  }
  if (fresh.length > 0) {
    await writeAudit({
      actorUserId: actor.id, action: 'updated', entityType: 'purchasing_document', entityId: id,
      changes: { after: { recipients_added: fresh.map((r) => r.supplier_id ?? r.key) } },
    });
  }
  const recipients = (await listRecipients(id)).map((r) => ({ ...r, key: partyKey(r), link: quoteLink(r.token) }));
  return NextResponse.json({ recipients, added_keys: fresh.map((r) => (r.supplier_id ?? r.key) as string) });
}
