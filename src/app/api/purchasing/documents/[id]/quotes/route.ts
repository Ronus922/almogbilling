import { NextResponse, type NextRequest } from 'next/server';
import { requirePermission, type Actor } from '@/lib/auth/actor';
import { authErrorResponse } from '@/lib/auth/apiGuard';
import { parseJsonBody } from '@/lib/http/body';
import { writeAudit } from '@/lib/db/audit';
import { deleteQuote, findDocument, getSupplierBrief, listLines, upsertQuote } from '@/lib/db/purchasing';
import { manualQuoteBodySchema } from '@/lib/validation/purchasing';
import { removePurchasingObjects } from '@/lib/storage/purchasingStorage';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// PUT /api/purchasing/documents/[id]/quotes — a quote received OUTSIDE the
// system (an e-mail, a file): the supplier, a total before VAT, optionally the
// per-line prices. One quote per (request, supplier): a second PUT replaces it.
export async function PUT(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  let actor: Actor;
  try { actor = await requirePermission('purchasing', 'edit'); }
  catch (err) { const r = authErrorResponse(err); if (r) return r; throw err; }
  const { id } = await ctx.params;
  if (!UUID.test(id)) return NextResponse.json({ error: 'not_found' }, { status: 404 });
  const body = await parseJsonBody(req, manualQuoteBodySchema);
  if (!body.ok) return body.response;

  const doc = await findDocument(id);
  if (!doc || doc.doc_type !== 'rfq') return NextResponse.json({ error: 'not_found' }, { status: 404 });
  if (!(await getSupplierBrief(body.data.supplier_id))) return NextResponse.json({ error: 'הספק לא נמצא' }, { status: 400 });

  // Every priced line must be a line of THIS request.
  const lineIds = new Set((await listLines(id)).map((l) => l.id));
  if (Object.keys(body.data.prices).some((lid) => !lineIds.has(lid))) {
    return NextResponse.json({ error: 'שורה לא שייכת לבקשה' }, { status: 400 });
  }

  const quoteId = await upsertQuote({
    rfq_id: id, supplier_id: body.data.supplier_id, source: 'manual',
    total_amount: body.data.total_amount, valid_until: body.data.valid_until, notes: body.data.notes,
    prices: body.data.prices, actor_id: actor.id,
  });
  await writeAudit({
    actorUserId: actor.id, action: 'created', entityType: 'purchasing_quote', entityId: quoteId,
    changes: { after: { rfq_id: id, supplier_id: body.data.supplier_id, source: 'manual' } },
  });
  return NextResponse.json({ id: quoteId }, { status: 201 });
}

// DELETE /api/purchasing/documents/[id]/quotes?supplier_id= — drops a quote
// (and its files); if it was the winner, the choice is cleared with it.
export async function DELETE(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  let actor: Actor;
  try { actor = await requirePermission('purchasing', 'edit'); }
  catch (err) { const r = authErrorResponse(err); if (r) return r; throw err; }
  const { id } = await ctx.params;
  const supplierId = req.nextUrl.searchParams.get('supplier_id') ?? '';
  if (!UUID.test(id) || !UUID.test(supplierId)) return NextResponse.json({ error: 'not_found' }, { status: 404 });
  const files = await deleteQuote(id, supplierId);
  await removePurchasingObjects(files.map((f) => f.object_key));
  await writeAudit({
    actorUserId: actor.id, action: 'deleted', entityType: 'purchasing_quote', entityId: id,
    changes: { before: { rfq_id: id, supplier_id: supplierId } },
  });
  return NextResponse.json({ ok: true });
}
