import { NextResponse, type NextRequest } from 'next/server';
import { deleteFileRow, findFile, findPublicContext } from '@/lib/db/purchasing';
import { readPurchasingObject, removePurchasingObjects } from '@/lib/storage/purchasingStorage';
import { PUBLIC_HEADERS, publicReadGate, publicWriteGate } from '@/lib/purchasing/publicGate';
import { isRfqOpen } from '@/lib/purchasing/model';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const nf = () => NextResponse.json({ error: 'not_found' }, { status: 404, headers: PUBLIC_HEADERS });

interface Ctx { params: Promise<{ token: string; fileId: string }> }

/** The token's own scope: the request's attachments and THIS supplier's quote
 *  files — a file id of any other request / supplier is a 404. */
async function scopedFile(token: string, fileId: string) {
  if (!UUID.test(fileId)) return null;
  const found = await findPublicContext(token);
  if (!found) return null;
  const file = await findFile(fileId);
  if (!file) return null;
  const ownsDoc = file.document_id === found.rfq.id;
  const ownsQuote = !!found.quote && file.quote_id === found.quote.id;
  return ownsDoc || ownsQuote ? { found, file, ownsQuote } : null;
}

// GET — download a file of the request or of the supplier's own quote.
export async function GET(req: NextRequest, ctx: Ctx) {
  const blocked = await publicReadGate(req);
  if (blocked) return blocked;
  const { token, fileId } = await ctx.params;
  const scoped = await scopedFile(token, fileId);
  if (!scoped) return nf();
  const bytes = await readPurchasingObject(scoped.file.object_key);
  if (!bytes) return nf();
  const name = scoped.file.original_filename;
  const ascii = name.replace(/[^\x20-\x7E]/g, '_').replace(/["\\]/g, '_') || 'file';
  return new NextResponse(new Uint8Array(bytes), {
    status: 200,
    headers: {
      ...PUBLIC_HEADERS,
      'Content-Type': scoped.file.mime_type,
      'Content-Disposition': `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`,
      'Content-Length': String(bytes.byteLength),
      // Whatever the bytes are, never let a browser sniff them into a page.
      'X-Content-Type-Options': 'nosniff',
    },
  });
}

// DELETE — the supplier removes a file THEY uploaded, while the request is open.
export async function DELETE(req: NextRequest, ctx: Ctx) {
  const { token, fileId } = await ctx.params;
  const blocked = await publicWriteGate(req, token);
  if (blocked) return blocked;
  const scoped = await scopedFile(token, fileId);
  if (!scoped || !scoped.ownsQuote || scoped.file.uploaded_via !== 'supplier') return nf();
  if (!isRfqOpen(scoped.found.rfq.due_date)) {
    return NextResponse.json({ error: 'closed', message: 'חלף תאריך היעד להגשה' }, { status: 403, headers: PUBLIC_HEADERS });
  }
  await deleteFileRow(scoped.file.id);
  await removePurchasingObjects([scoped.file.object_key]);
  return NextResponse.json({ ok: true }, { headers: PUBLIC_HEADERS });
}
