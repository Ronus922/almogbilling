import { NextResponse, type NextRequest } from 'next/server';
import { denyPurchasingType, requirePurchasingAny } from '@/lib/auth/purchasingGuard';
import type { Actor } from '@/lib/auth/actor';
import { authErrorResponse } from '@/lib/auth/apiGuard';
import { deleteFileRow, findDocument, findFile } from '@/lib/db/purchasing';
import { removePurchasingObjects } from '@/lib/storage/purchasingStorage';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// DELETE /api/purchasing/files/[fileId] — an attachment of a document or a quote.
export async function DELETE(_req: NextRequest, ctx: { params: Promise<{ fileId: string }> }) {
  let actor: Actor;
  try { actor = await requirePurchasingAny('edit'); }
  catch (err) { const r = authErrorResponse(err); if (r) return r; throw err; }
  const { fileId } = await ctx.params;
  if (!UUID.test(fileId)) return NextResponse.json({ error: 'not_found' }, { status: 404 });
  const file = await findFile(fileId);
  if (!file) return NextResponse.json({ error: 'not_found' }, { status: 404 });
  // A quote's file belongs to a request; a document's file to that document's own type.
  const owner = file.document_id ? await findDocument(file.document_id) : null;
  const denied = denyPurchasingType(actor, owner ? owner.doc_type : 'rfq', 'edit');
  if (denied) return denied;
  await deleteFileRow(fileId);
  await removePurchasingObjects([file.object_key]);
  return NextResponse.json({ ok: true });
}
