import { NextResponse, type NextRequest } from 'next/server';
import { requirePermission, type Actor } from '@/lib/auth/actor';
import { authErrorResponse } from '@/lib/auth/apiGuard';
import { writeAudit } from '@/lib/db/audit';
import { deleteQuote } from '@/lib/db/purchasing';
import { MANUAL_PARTY } from '@/lib/purchasing/model';
import { removePurchasingObjects } from '@/lib/storage/purchasingStorage';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// DELETE /api/purchasing/documents/[id]/quotes?supplier_id=<uuid|manual> — drops a quote
// (and its files); if it was the winner, the choice is cleared with it.
export async function DELETE(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  let actor: Actor;
  try { actor = await requirePermission('purchasing', 'edit'); }
  catch (err) { const r = authErrorResponse(err); if (r) return r; throw err; }
  const { id } = await ctx.params;
  const party = req.nextUrl.searchParams.get('supplier_id') ?? '';
  const manual = party === MANUAL_PARTY;
  if (!UUID.test(id) || (!manual && !UUID.test(party))) return NextResponse.json({ error: 'not_found' }, { status: 404 });
  const files = await deleteQuote(id, manual ? null : party);
  await removePurchasingObjects(files.map((f) => f.object_key));
  await writeAudit({
    actorUserId: actor.id, action: 'deleted', entityType: 'purchasing_quote', entityId: id,
    changes: { before: { rfq_id: id, supplier_id: manual ? null : party } },
  });
  return NextResponse.json({ ok: true });
}
