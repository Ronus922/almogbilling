import { NextResponse, type NextRequest } from 'next/server';
import { requirePermission } from '@/lib/auth/actor';
import { authErrorResponse } from '@/lib/auth/apiGuard';
import { parseJsonBody } from '@/lib/http/body';
import { getSequenceState, getSupplierBrief } from '@/lib/db/purchasing';
import { createBodySchema } from '@/lib/validation/purchasing';
import { buildPreviewPdf, CompanyMissingError } from '@/lib/purchasing/service';
import type { PdfSupplier } from '@/lib/purchasing/pdf';
import { logger } from '@/lib/logger';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// POST /api/purchasing/preview — the form's body (same as a create), rendered
// to a PDF with the number the document would get right now. Saves nothing and
// allocates no number.
export async function POST(req: NextRequest) {
  try { await requirePermission('purchasing', 'edit'); }
  catch (err) { const r = authErrorResponse(err); if (r) return r; throw err; }
  const body = await parseJsonBody(req, createBodySchema);
  if (!body.ok) return body.response;
  const b = body.data;

  let supplier: PdfSupplier | null = null;
  if (b.supplier_id) {
    const s = await getSupplierBrief(b.supplier_id);
    if (!s) return NextResponse.json({ error: 'הספק לא נמצא' }, { status: 400 });
    supplier = { name: s.name, address: s.address, phone: s.mobile || s.phone };
  } else if (b.supplier_name) {
    supplier = { name: b.supplier_name, address: b.supplier_address ?? '', phone: b.supplier_phone ?? '' };
  }

  // Editing an issued document previews with its own number (?number=).
  const given = Number(req.nextUrl.searchParams.get('number'));
  const last = (await getSequenceState())[b.doc_type];
  const number = Number.isInteger(given) && given > 0 ? given : last === null ? (b.start_number ?? 1) : last + 1;
  try {
    const bytes = await buildPreviewPdf({
      doc_type: b.doc_type, doc_date: b.doc_date, title: b.title, notes: b.notes,
      due_date: b.doc_type === 'rfq' ? b.due_date : null, supplier, lines: b.lines,
    }, number);
    return new NextResponse(new Uint8Array(bytes), {
      headers: { 'Content-Type': 'application/pdf', 'Content-Disposition': 'inline', 'Cache-Control': 'no-store' },
    });
  } catch (err) {
    if (err instanceof CompanyMissingError) return NextResponse.json({ error: 'company_missing' }, { status: 409 });
    logger.error('[POST /api/purchasing/preview] failed', err);
    return NextResponse.json({ error: 'יצירת התצוגה המקדימה נכשלה' }, { status: 500 });
  }
}
