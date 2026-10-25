import { NextResponse, type NextRequest } from 'next/server';
import { type Actor } from '@/lib/auth/actor';
import { denyPurchasingType, requirePurchasingAny } from '@/lib/auth/purchasingGuard';
import { authErrorResponse } from '@/lib/auth/apiGuard';
import { parseJsonBody } from '@/lib/http/body';
import { writeAudit } from '@/lib/db/audit';
import {
  deleteDraft, findDocument, getCompany, getSupplierBrief, isRfqLocked, listDispatches, listDocumentFiles, listLines,
  listQuotes, listRecipients, listSupplierBriefs, markQuotesSeen, NotADraftError, softDeleteDocument,
  StartNumberRequiredError, updateDocument,
} from '@/lib/db/purchasing';
import {
  bodyHasSupplier, createBodySchema, draftBodySchema, RFQ_TITLE_REQUIRED, SUPPLIER_REQUIRED_MESSAGE,
  updateDocumentBodySchema,
} from '@/lib/validation/purchasing';
import { companyIsComplete, todayIsrael } from '@/lib/purchasing/model';
import { logger } from '@/lib/logger';
import { buildProxyUrl, PURCHASING_FILES_BUCKET } from '@/lib/storage/server';
import { quoteLink } from '@/lib/purchasing/service';
import { NO_SUPPLIER, supplierFieldsOf } from '@/lib/purchasing/supplier';
import { removePurchasingObjects } from '@/lib/storage/purchasingStorage';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

interface Ctx { params: Promise<{ id: string }> }

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const recipientsExist = async (rs: ReadonlyArray<{ supplier_id: string | null }>) => {
  const ids = rs.flatMap((r) => (r.supplier_id ? [r.supplier_id] : []));
  return (await listSupplierBriefs(ids)).length === ids.length;
};

const withUrl = <T extends { object_key: string }>(f: T) => ({ ...f, url: buildProxyUrl(PURCHASING_FILES_BUCKET, f.object_key) });

// GET /api/purchasing/documents/[id] — the document with everything the panel
// shows: lines, files, dispatch log and, for a request, the recipients (with
// their personal links) and the quotes received.
export async function GET(_req: NextRequest, ctx: Ctx) {
  let actor: Actor;
  try { actor = await requirePurchasingAny('view'); }
  catch (err) { const r = authErrorResponse(err); if (r) return r; throw err; }
  const { id } = await ctx.params;
  if (!UUID.test(id)) return NextResponse.json({ error: 'not_found' }, { status: 404 });
  const doc = await findDocument(id);
  if (!doc) return NextResponse.json({ error: 'not_found' }, { status: 404 });
  const denied = denyPurchasingType(actor, doc.doc_type, 'view');
  if (denied) return denied;

  // Opening a request is what makes its quotes "seen" (one stamp per request).
  if (doc.doc_type === 'rfq' && doc.status === 'issued') {
    await markQuotesSeen(id).catch((e) => logger.error('[GET purchasing document] seen stamp failed', e));
  }

  const [lines, files, dispatches] = await Promise.all([listLines(id), listDocumentFiles(id), listDispatches(id)]);
  const out: Record<string, unknown> = {
    document: doc,
    lines,
    files: files.map(withUrl),
    dispatches,
    supplier: doc.supplier_id ? await getSupplierBrief(doc.supplier_id) : null,
  };
  if (doc.doc_type === 'rfq') {
    const [recipients, quotes] = await Promise.all([listRecipients(id), listQuotes(id)]);
    out.recipients = recipients.map((r) => ({ ...r, link: quoteLink(r.token) }));
    out.lines_locked = await isRfqLocked(id);
    out.quotes = quotes.map((q) => ({ ...q, files: q.files.map(withUrl) }));
  }
  return NextResponse.json(out);
}

// PATCH /api/purchasing/documents/[id] — the form's fields (date, supplier,
// description, due date, notes) and, while allowed, the lines. The number and
// the VAT rate are never editable. A request's lines are locked once it was
// sent: suppliers have priced exactly those lines.
//   (no mode)     edit an ISSUED document
//   ?mode=draft   save a DRAFT again (lenient, no number)
//   ?mode=issue   turn a draft into an issued document: strict validation, the
//                 running number is allocated now, the company VAT is stamped
export async function PATCH(req: NextRequest, ctx: Ctx) {
  let actor: Actor;
  try { actor = await requirePurchasingAny('edit'); }
  catch (err) { const r = authErrorResponse(err); if (r) return r; throw err; }
  const { id } = await ctx.params;
  if (!UUID.test(id)) return NextResponse.json({ error: 'not_found' }, { status: 404 });
  const mode = req.nextUrl.searchParams.get('mode');
  const doc = await findDocument(id);
  if (!doc) return NextResponse.json({ error: 'not_found' }, { status: 404 });
  const denied = denyPurchasingType(actor, doc.doc_type, 'edit');
  if (denied) return denied;
  const isDraft = doc.status === 'draft';
  if (mode === 'draft' || mode === 'issue') {
    if (!isDraft) return NextResponse.json({ error: 'המסמך כבר הופק' }, { status: 409 });
  } else if (isDraft) {
    return NextResponse.json({ error: 'טיוטה נשמרת כטיוטה או מופקת' }, { status: 409 });
  }

  if (mode === 'draft') {
    const body = await parseJsonBody(req, draftBodySchema);
    if (!body.ok) return body.response;
    if (body.data.doc_type !== doc.doc_type) return NextResponse.json({ error: 'סוג המסמך אינו תואם' }, { status: 400 });
    if (doc.doc_type === 'po' && body.data.supplier_id && !(await getSupplierBrief(body.data.supplier_id))) {
      return NextResponse.json({ error: 'הספק לא נמצא' }, { status: 400 });
    }
    if (doc.doc_type === 'rfq' && !(await recipientsExist(body.data.recipients))) {
      return NextResponse.json({ error: 'אחד הספקים לא נמצא' }, { status: 400 });
    }
    await updateDocument(id, {
      doc_date: body.data.doc_date, title: body.data.title,
      ...(doc.doc_type === 'rfq' ? NO_SUPPLIER : supplierFieldsOf(body.data)),
      notes: body.data.notes, due_date: doc.doc_type === 'rfq' ? body.data.due_date : null, lines: body.data.lines,
      ...(doc.doc_type === 'rfq'
        ? { recipients: body.data.recipients, send_email: body.data.send_email, send_whatsapp: body.data.send_whatsapp }
        : {}),
    });
    await writeAudit({
      actorUserId: actor.id, action: 'updated', entityType: 'purchasing_document', entityId: id,
      changes: { after: { draft: true, lines_replaced: true } },
    });
    return NextResponse.json({ ok: true, number: null });
  }

  if (mode === 'issue') {
    const body = await parseJsonBody(req, createBodySchema);
    if (!body.ok) return body.response;
    const b = body.data;
    if (b.doc_type !== doc.doc_type) return NextResponse.json({ error: 'סוג המסמך אינו תואם' }, { status: 400 });
    const company = await getCompany();
    if (!companyIsComplete(company) || !company) return NextResponse.json({ error: 'company_missing' }, { status: 409 });
    if (b.doc_type === 'rfq' && b.due_date < todayIsrael()) {
      return NextResponse.json({ error: 'תאריך היעד להגשה כבר עבר' }, { status: 400 });
    }
    if (b.doc_type === 'po' && b.supplier_id && !(await getSupplierBrief(b.supplier_id))) {
      return NextResponse.json({ error: 'הספק לא נמצא' }, { status: 400 });
    }
    if (b.doc_type === 'rfq' && !(await recipientsExist(b.recipients))) {
      return NextResponse.json({ error: 'אחד הספקים לא נמצא' }, { status: 400 });
    }
    try {
      const done = await updateDocument(id, {
        doc_date: b.doc_date, title: b.title, ...(b.doc_type === 'rfq' ? NO_SUPPLIER : supplierFieldsOf(b)), notes: b.notes,
        due_date: b.doc_type === 'rfq' ? b.due_date : null, lines: b.lines,
        ...(b.doc_type === 'rfq' ? { recipients: b.recipients, send_email: b.send_email, send_whatsapp: b.send_whatsapp } : {}),
        issue: { start_number: b.start_number, vat_rate: company.vat_rate },
      });
      if (!done) return NextResponse.json({ error: 'not_found' }, { status: 404 });
      await writeAudit({
        actorUserId: actor.id, action: 'created', entityType: 'purchasing_document', entityId: id,
        changes: { after: { doc_type: b.doc_type, number: done.number, issued_from_draft: true } },
      });
      return NextResponse.json({ ok: true, number: done.number });
    } catch (err) {
      if (err instanceof StartNumberRequiredError) return NextResponse.json({ error: 'start_number_required' }, { status: 409 });
      if (err instanceof NotADraftError) return NextResponse.json({ error: 'המסמך כבר הופק' }, { status: 409 });
      logger.error('[PATCH /api/purchasing/documents/[id]] issue failed', err);
      return NextResponse.json({ error: 'הפקת המסמך נכשלה' }, { status: 500 });
    }
  }

  const body = await parseJsonBody(req, updateDocumentBodySchema);
  if (!body.ok) return body.response;
  const lines = body.data.lines;
  // A request needs its subject — except one that never had it (the rule came
  // later): it may still be edited as long as the stored subject stays empty.
  if (doc.doc_type === 'rfq' && body.data.title === '' && doc.title !== '') {
    return NextResponse.json({ error: RFQ_TITLE_REQUIRED }, { status: 400 });
  }
  if (doc.doc_type === 'rfq') {
    if (lines && (await isRfqLocked(id))) {
      return NextResponse.json({ error: 'לא ניתן לשנות שורות אחרי ששלחו את הבקשה לספקים' }, { status: 409 });
    }
    if (!body.data.due_date) return NextResponse.json({ error: 'תאריך יעד הוא שדה חובה' }, { status: 400 });
  } else if (lines && lines.some((l) => l.unit_price === null)) {
    return NextResponse.json({ error: 'יש להזין מחיר בכל שורה' }, { status: 400 });
  }
  if (doc.doc_type === 'po') {
    if (!bodyHasSupplier(body.data)) return NextResponse.json({ error: SUPPLIER_REQUIRED_MESSAGE }, { status: 400 });
    if (body.data.supplier_id && !(await getSupplierBrief(body.data.supplier_id))) {
      return NextResponse.json({ error: 'הספק לא נמצא' }, { status: 400 });
    }
  }

  await updateDocument(id, {
    doc_date: body.data.doc_date,
    title: body.data.title,
    // A request's supplier columns stay as they are (its suppliers are its recipients).
    ...(doc.doc_type === 'rfq'
      ? { supplier_id: doc.supplier_id, supplier_name: doc.supplier_id ? null : doc.supplier_name, supplier_phone: doc.supplier_phone, supplier_email: doc.supplier_email, supplier_address: doc.supplier_address }
      : supplierFieldsOf(body.data)),
    notes: body.data.notes,
    due_date: doc.doc_type === 'rfq' ? body.data.due_date : null,
    lines,
  });
  await writeAudit({
    actorUserId: actor.id, action: 'updated', entityType: 'purchasing_document', entityId: id,
    changes: { before: { title: doc.title, notes: doc.notes }, after: { title: body.data.title, notes: body.data.notes, lines_replaced: !!lines } },
  });
  return NextResponse.json({ ok: true });
}

// DELETE /api/purchasing/documents/[id] — an issued document is soft-deleted
// (its number is never reissued); a DRAFT never had a number and is removed for good.
export async function DELETE(_req: NextRequest, ctx: Ctx) {
  let actor: Actor;
  try { actor = await requirePurchasingAny('edit'); }
  catch (err) { const r = authErrorResponse(err); if (r) return r; throw err; }
  const { id } = await ctx.params;
  if (!UUID.test(id)) return NextResponse.json({ error: 'not_found' }, { status: 404 });
  const doc = await findDocument(id);
  if (!doc) return NextResponse.json({ error: 'not_found' }, { status: 404 });
  const denied = denyPurchasingType(actor, doc.doc_type, 'edit');
  if (denied) return denied;
  // A request the suppliers can still see must not vanish under them silently:
  // it is closed (soft-deleted → every link answers 404) only on purpose.
  const files = await listDocumentFiles(id);
  const removed = doc.status === 'draft' ? await deleteDraft(id) : await softDeleteDocument(id);
  if (!removed) return NextResponse.json({ error: 'not_found' }, { status: 404 });
  await removePurchasingObjects(files.map((f) => f.object_key));
  await writeAudit({
    actorUserId: actor.id, action: 'deleted', entityType: 'purchasing_document', entityId: id,
    changes: { before: { doc_type: doc.doc_type, number: doc.number, draft: doc.status === 'draft' } },
  });
  return NextResponse.json({ ok: true });
}
