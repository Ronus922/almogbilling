import { NextResponse, type NextRequest } from 'next/server';
import { requirePermission, type Actor } from '@/lib/auth/actor';
import { authErrorResponse } from '@/lib/auth/apiGuard';
import { parseJsonBody } from '@/lib/http/body';
import { writeAudit } from '@/lib/db/audit';
import { findDocument, findQuote, setWinner } from '@/lib/db/purchasing';
import { winnerBodySchema } from '@/lib/validation/purchasing';
import { MANUAL_PARTY } from '@/lib/purchasing/model';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// PUT /api/purchasing/documents/[id]/winner — { supplier_id: uuid | 'manual' } picks the winning
// quote (one supplier per request); { supplier_id: null } clears it. There is
// no approval flow: the system only records who chose, and when.
export async function PUT(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  let actor: Actor;
  try { actor = await requirePermission('purchasing', 'edit'); }
  catch (err) { const r = authErrorResponse(err); if (r) return r; throw err; }
  const { id } = await ctx.params;
  if (!UUID.test(id)) return NextResponse.json({ error: 'not_found' }, { status: 404 });
  const body = await parseJsonBody(req, winnerBodySchema);
  if (!body.ok) return body.response;

  const doc = await findDocument(id);
  if (!doc || doc.doc_type !== 'rfq') return NextResponse.json({ error: 'not_found' }, { status: 404 });
  if (body.data.supplier_id && !(await findQuote(id, body.data.supplier_id === MANUAL_PARTY ? null : body.data.supplier_id))) {
    return NextResponse.json({ error: 'אין הצעה מהספק הזה' }, { status: 400 });
  }
  await setWinner(id, body.data.supplier_id, actor.id);
  await writeAudit({
    actorUserId: actor.id, action: 'updated', entityType: 'purchasing_document', entityId: id,
    changes: { before: { winner: doc.winner_manual ? MANUAL_PARTY : doc.winner_supplier_id }, after: { winner: body.data.supplier_id } },
  });
  return NextResponse.json({ ok: true });
}
