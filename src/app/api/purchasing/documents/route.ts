import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';
import { requirePermission, type Actor } from '@/lib/auth/actor';
import { authErrorResponse } from '@/lib/auth/apiGuard';
import { parseJsonBody } from '@/lib/http/body';
import { writeAudit } from '@/lib/db/audit';
import {
  createDocument, findDocument, getCompany, getSupplierBrief, listDocuments, StartNumberRequiredError,
} from '@/lib/db/purchasing';
import { createPoBodySchema, createRfqBodySchema } from '@/lib/validation/purchasing';
import { companyIsComplete, DOC_TYPES, todayIsrael, type DocType } from '@/lib/purchasing/model';
import { logger } from '@/lib/logger';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const createSchema = z.discriminatedUnion('doc_type', [
  createRfqBodySchema.extend({ doc_type: z.literal('rfq') }),
  createPoBodySchema.extend({ doc_type: z.literal('po') }),
]);

// GET /api/purchasing/documents?type=rfq|po
export async function GET(req: NextRequest) {
  try { await requirePermission('purchasing', 'view'); }
  catch (err) { const r = authErrorResponse(err); if (r) return r; throw err; }
  const type = req.nextUrl.searchParams.get('type');
  if (!DOC_TYPES.includes(type as DocType)) return NextResponse.json({ error: 'סוג מסמך לא תקין' }, { status: 400 });
  return NextResponse.json({ documents: await listDocuments(type as DocType) });
}

// POST /api/purchasing/documents — issue a request for quotation or a purchase
// order. The number is allocated atomically with the insert; the VAT rate is
// stamped from the company setting AT THIS MOMENT and never changes afterwards.
export async function POST(req: NextRequest) {
  let actor: Actor;
  try { actor = await requirePermission('purchasing', 'edit'); }
  catch (err) { const r = authErrorResponse(err); if (r) return r; throw err; }
  const body = await parseJsonBody(req, createSchema);
  if (!body.ok) return body.response;
  const b = body.data;

  const company = await getCompany();
  if (!companyIsComplete(company) || !company) {
    return NextResponse.json({ error: 'company_missing' }, { status: 409 });
  }

  if (b.doc_type === 'rfq' && b.due_date < todayIsrael()) {
    return NextResponse.json({ error: 'תאריך היעד להגשה כבר עבר' }, { status: 400 });
  }
  if (b.doc_type === 'po') {
    if (!(await getSupplierBrief(b.supplier_id))) return NextResponse.json({ error: 'הספק לא נמצא' }, { status: 400 });
    if (b.source_rfq_id) {
      const src = await findDocument(b.source_rfq_id);
      if (!src || src.doc_type !== 'rfq') return NextResponse.json({ error: 'בקשת ההצעה לא נמצאה' }, { status: 400 });
    }
  }

  try {
    const created = await createDocument(
      {
        doc_type: b.doc_type,
        doc_date: b.doc_date,
        title: b.title,
        supplier_id: b.doc_type === 'po' ? b.supplier_id : null,
        notes: b.notes,
        due_date: b.doc_type === 'rfq' ? b.due_date : null,
        vat_rate: company.vat_rate,
        source_rfq_id: b.doc_type === 'po' ? b.source_rfq_id : null,
        start_number: b.start_number,
        lines: b.lines,
      },
      actor.id,
    );
    await writeAudit({
      actorUserId: actor.id, action: 'created', entityType: 'purchasing_document', entityId: created.id,
      changes: { after: { doc_type: b.doc_type, number: created.number } },
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
