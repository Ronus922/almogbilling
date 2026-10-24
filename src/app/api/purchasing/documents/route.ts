import { NextResponse, type NextRequest } from 'next/server';
import { type Actor } from '@/lib/auth/actor';
import { denyPurchasingType, requirePurchasingAny } from '@/lib/auth/purchasingGuard';
import { authErrorResponse } from '@/lib/auth/apiGuard';
import { parseJsonBody } from '@/lib/http/body';
import { writeAudit } from '@/lib/db/audit';
import {
  createDocument, findDocument, getCompany, getSupplierBrief, listDocuments, StartNumberRequiredError,
} from '@/lib/db/purchasing';
import { createBodySchema, draftBodySchema } from '@/lib/validation/purchasing';
import { supplierFieldsOf } from '@/lib/purchasing/supplier';
import { companyIsComplete, DEFAULT_VAT_RATE, DOC_TYPES, todayIsrael, type DocType } from '@/lib/purchasing/model';
import { logger } from '@/lib/logger';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// GET /api/purchasing/documents?type=rfq|po — issued documents and drafts
// (drafts first, `number` null).
export async function GET(req: NextRequest) {
  let actor: Actor;
  try { actor = await requirePurchasingAny('view'); }
  catch (err) { const r = authErrorResponse(err); if (r) return r; throw err; }
  const type = req.nextUrl.searchParams.get('type');
  if (!DOC_TYPES.includes(type as DocType)) return NextResponse.json({ error: 'סוג מסמך לא תקין' }, { status: 400 });
  const denied = denyPurchasingType(actor, type as DocType, 'view');
  if (denied) return denied;
  return NextResponse.json({ documents: await listDocuments(type as DocType) });
}

// POST /api/purchasing/documents — issue a request for quotation or a purchase
// order. The number is allocated atomically with the insert; the VAT rate is
// stamped from the company setting AT THIS MOMENT and never changes afterwards.
// POST …?mode=draft saves the form as a DRAFT instead: no number is taken, the
// validation is lenient, and the company letterhead is not required yet.
export async function POST(req: NextRequest) {
  let actor: Actor;
  try { actor = await requirePurchasingAny('edit'); }
  catch (err) { const r = authErrorResponse(err); if (r) return r; throw err; }
  const isDraft = req.nextUrl.searchParams.get('mode') === 'draft';
  const parsed = isDraft ? await parseJsonBody(req, draftBodySchema) : await parseJsonBody(req, createBodySchema);
  if (!parsed.ok) return parsed.response;
  const b = parsed.data;
  // The coarse guard above only proved SOME purchasing edit right: this document's own key decides.
  const denied = denyPurchasingType(actor, b.doc_type, 'edit');
  if (denied) return denied;
  const startNumber = 'start_number' in b ? b.start_number : null;

  const company = await getCompany();
  if (!isDraft && (!companyIsComplete(company) || !company)) {
    return NextResponse.json({ error: 'company_missing' }, { status: 409 });
  }

  if (!isDraft && b.doc_type === 'rfq' && b.due_date !== null && b.due_date < todayIsrael()) {
    return NextResponse.json({ error: 'תאריך היעד להגשה כבר עבר' }, { status: 400 });
  }
  if (b.supplier_id && !(await getSupplierBrief(b.supplier_id))) {
    return NextResponse.json({ error: 'הספק לא נמצא' }, { status: 400 });
  }
  if (b.doc_type === 'po' && b.source_rfq_id) {
    const src = await findDocument(b.source_rfq_id);
    if (!src || src.doc_type !== 'rfq') return NextResponse.json({ error: 'בקשת ההצעה לא נמצאה' }, { status: 400 });
  }

  try {
    const created = await createDocument(
      {
        doc_type: b.doc_type,
        status: isDraft ? 'draft' : 'issued',
        doc_date: b.doc_date,
        title: b.title,
        ...supplierFieldsOf(b),
        notes: b.notes,
        due_date: b.doc_type === 'rfq' ? b.due_date : null,
        vat_rate: company?.vat_rate ?? DEFAULT_VAT_RATE,
        source_rfq_id: b.doc_type === 'po' ? b.source_rfq_id : null,
        start_number: isDraft ? null : startNumber,
        lines: b.lines,
      },
      actor.id,
    );
    await writeAudit({
      actorUserId: actor.id, action: 'created', entityType: 'purchasing_document', entityId: created.id,
      changes: { after: { doc_type: b.doc_type, number: created.number, draft: isDraft } },
    });
    return NextResponse.json(created, { status: 201 });
  } catch (err) {
    if (err instanceof StartNumberRequiredError) {
      return NextResponse.json({ error: 'start_number_required' }, { status: 409 });
    }
    logger.error('[POST /api/purchasing/documents] failed', err);
    return NextResponse.json({ error: 'יצירת המסמך נכשלה' }, { status: 500 });
  }
}
