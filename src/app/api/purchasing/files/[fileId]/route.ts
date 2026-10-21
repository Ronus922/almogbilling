import { NextResponse, type NextRequest } from 'next/server';
import { requirePermission } from '@/lib/auth/actor';
import { authErrorResponse } from '@/lib/auth/apiGuard';
import { deleteFileRow, findFile } from '@/lib/db/purchasing';
import { removePurchasingObjects } from '@/lib/storage/purchasingStorage';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// DELETE /api/purchasing/files/[fileId] — an attachment of a document or a quote.
export async function DELETE(_req: NextRequest, ctx: { params: Promise<{ fileId: string }> }) {
  try { await requirePermission('purchasing', 'edit'); }
  catch (err) { const r = authErrorResponse(err); if (r) return r; throw err; }
  const { fileId } = await ctx.params;
  if (!UUID.test(fileId)) return NextResponse.json({ error: 'not_found' }, { status: 404 });
  const file = await findFile(fileId);
  if (!file) return NextResponse.json({ error: 'not_found' }, { status: 404 });
  await deleteFileRow(fileId);
  await removePurchasingObjects([file.object_key]);
  return NextResponse.json({ ok: true });
}
