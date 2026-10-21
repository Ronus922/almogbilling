import { NextResponse, type NextRequest } from 'next/server';
import { requirePermission } from '@/lib/auth/actor';
import { authErrorResponse } from '@/lib/auth/apiGuard';
import { getSupplierBrief } from '@/lib/db/purchasing';
import { buildDocumentPdf, CompanyMissingError } from '@/lib/purchasing/service';
import { logger } from '@/lib/logger';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// GET /api/purchasing/documents/[id]/pdf[?supplier_id=][&download=1]
// The letterhead PDF of a request (no prices) or a purchase order. For a request
// `supplier_id` personalises the "לכבוד" block; without it the copy is generic.
export async function GET(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  try { await requirePermission('purchasing', 'view'); }
  catch (err) { const r = authErrorResponse(err); if (r) return r; throw err; }
  const { id } = await ctx.params;
  if (!UUID.test(id)) return NextResponse.json({ error: 'not_found' }, { status: 404 });
  const supplierId = req.nextUrl.searchParams.get('supplier_id');
  if (supplierId && !UUID.test(supplierId)) return NextResponse.json({ error: 'not_found' }, { status: 404 });

  try {
    const supplier = supplierId ? await getSupplierBrief(supplierId) : null;
    const pdf = await buildDocumentPdf(id, supplier);
    if (!pdf) return NextResponse.json({ error: 'not_found' }, { status: 404 });
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
    if (err instanceof CompanyMissingError) return NextResponse.json({ error: 'company_missing' }, { status: 409 });
    logger.error('[GET /api/purchasing/documents/pdf] failed', err);
    return NextResponse.json({ error: 'יצירת ה-PDF נכשלה' }, { status: 500 });
  }
}
