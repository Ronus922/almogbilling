import { NextResponse, type NextRequest } from 'next/server';
import { denyPurchasingType, requirePurchasingAny } from '@/lib/auth/purchasingGuard';
import type { Actor } from '@/lib/auth/actor';
import { authErrorResponse } from '@/lib/auth/apiGuard';
import { getSupplierBrief, listRecipients } from '@/lib/db/purchasing';
import { MANUAL_KEY_RE, partyKey } from '@/lib/purchasing/model';
import { briefToPdfSupplier, buildDocumentPdf, CompanyMissingError, DraftDocumentError } from '@/lib/purchasing/service';
import type { PdfSupplier } from '@/lib/purchasing/pdf';
import { logger } from '@/lib/logger';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// GET /api/purchasing/documents/[id]/pdf[?supplier_id=][&download=1]
// The letterhead PDF of a request (no prices) or a purchase order. For a request
// `party` (a recipient's supplier uuid or hand-typed key) addresses the "לכבוד"
// block to that recipient; `supplier_id` (a listed supplier) does the same; without
// either the copy is generic.
export async function GET(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  let actor: Actor;
  try { actor = await requirePurchasingAny('view'); }
  catch (err) { const r = authErrorResponse(err); if (r) return r; throw err; }
  const { id } = await ctx.params;
  if (!UUID.test(id)) return NextResponse.json({ error: 'not_found' }, { status: 404 });
  const party = req.nextUrl.searchParams.get('party') ?? req.nextUrl.searchParams.get('supplier_id');
  if (party && !UUID.test(party) && !MANUAL_KEY_RE.test(party)) return NextResponse.json({ error: 'not_found' }, { status: 404 });

  try {
    let supplier: PdfSupplier | null = null;
    if (party && UUID.test(party)) {
      const brief = await getSupplierBrief(party);
      supplier = brief ? briefToPdfSupplier(brief) : null;
    } else if (party) {
      // A request's hand-typed supplier: its details ride on its recipient row.
      const rec = (await listRecipients(id)).find((r) => partyKey(r) === party);
      if (!rec) return NextResponse.json({ error: 'not_found' }, { status: 404 });
      supplier = { name: rec.supplier_name, address: '', phone: rec.supplier_phone ?? '' };
    }
    const pdf = await buildDocumentPdf(id, supplier);
    if (!pdf) return NextResponse.json({ error: 'not_found' }, { status: 404 });
    const denied = denyPurchasingType(actor, pdf.doc.doc_type, 'view');
    if (denied) return denied;
    const kind = req.nextUrl.searchParams.get('download') === '1' ? 'attachment' : 'inline';
    const ascii = `${pdf.doc.doc_type}-${pdf.doc.number}.pdf`;
    return new NextResponse(new Uint8Array(pdf.bytes), {
      status: 200,
      headers: {
        'Content-Type': 'application/pdf',
        'Content-Disposition': `${kind}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(pdf.filename)}`,
        'Content-Length': String(pdf.bytes.byteLength),
        'Cache-Control': 'private, no-store',
      },
    });
  } catch (err) {
    if (err instanceof DraftDocumentError) return NextResponse.json({ error: 'לטיוטה אין PDF — יש להפיק את המסמך' }, { status: 409 });
    if (err instanceof CompanyMissingError) return NextResponse.json({ error: 'company_missing' }, { status: 409 });
    logger.error('[GET /api/purchasing/documents/pdf] failed', err);
    return NextResponse.json({ error: 'יצירת ה-PDF נכשלה' }, { status: 500 });
  }
}
