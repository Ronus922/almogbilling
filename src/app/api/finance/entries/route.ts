import { NextResponse, type NextRequest, after } from 'next/server';
import { requirePermission, type Actor } from '@/lib/auth/actor';
import { authErrorResponse } from '@/lib/auth/apiGuard';
import { parseJsonBody } from '@/lib/http/body';
import { financeEntryBodySchema } from '@/lib/validation/requests';
import { FIN_SECTIONS, type FinSection } from '@/lib/constants/finance';
import { createEntry, getEntry, listEntriesForMonth } from '@/lib/db/finance/entries';
import { linkDocuments } from '@/lib/db/finance/documents';
import { resolveEntryInput } from '@/lib/finance/entry-input';
import { syncDocumentsInBackground } from '@/lib/finance/drive-sync';
import { isMonthKey, periodMonthOf } from '@/lib/finance/period';
import { writeAudit } from '@/lib/db/audit';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// GET /api/finance/entries?m=YYYY-MM[&section=operating|renovation_fund] — the
// live entries of one month (both sections unless one is asked for).
export async function GET(req: NextRequest) {
  try { await requirePermission('finance', 'view'); }
  catch (err) { const r = authErrorResponse(err); if (r) return r; throw err; }
  const m = req.nextUrl.searchParams.get('m');
  if (!isMonthKey(m)) return NextResponse.json({ error: 'חודש לא תקין' }, { status: 400 });
  const s = req.nextUrl.searchParams.get('section');
  if (s !== null && !(FIN_SECTIONS as readonly string[]).includes(s)) {
    return NextResponse.json({ error: 'חלק לא תקין' }, { status: 400 });
  }
  const section = s === null ? undefined : (s as FinSection);
  return NextResponse.json({ month: m, entries: await listEntriesForMonth(periodMonthOf(m), { section }) });
}

// POST /api/finance/entries — a new income/expense line. Staged documents
// (document_ids, uploaded by this actor) are linked to it, and their Google
// Drive copies are made AFTER the response — a Drive failure never blocks a save.
export async function POST(req: NextRequest) {
  let actor: Actor;
  try { actor = await requirePermission('finance', 'edit'); }
  catch (err) { const r = authErrorResponse(err); if (r) return r; throw err; }

  const body = await parseJsonBody(req, financeEntryBodySchema);
  if (!body.ok) return body.response;

  const resolved = await resolveEntryInput(body.data, 'create');
  if (!resolved.ok) return NextResponse.json({ error: resolved.error }, { status: 400 });

  const created = await createEntry(resolved.input, actor.id);
  const linked = await linkDocuments(created.id, body.data.document_ids, actor.id);
  await writeAudit({
    actorUserId: actor.id, action: 'created', entityType: 'fin_entry', entityId: created.id,
    metadata: { kind: created.kind, amount: created.amount, period_month: created.period_month, documents: linked },
  });
  if (linked > 0) after(() => syncDocumentsInBackground(body.data.document_ids));

  const entry = linked > 0 ? await getEntry(created.id) : created;
  return NextResponse.json(
    { entry, documents_linked: linked, documents_requested: body.data.document_ids.length },
    { status: 201 },
  );
}
