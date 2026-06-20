import { NextResponse, type NextRequest } from 'next/server';
import { requirePermission } from '@/lib/auth/actor';
import { authErrorResponse } from '@/lib/auth/apiGuard';
import { reorderIssues, type IssueReorderItem } from '@/lib/db/issues';
import type { IssueStatus } from '@/lib/types/issues';

export const runtime = 'nodejs';

const STATUSES: readonly IssueStatus[] = ['open', 'in_progress', 'resolved', 'closed'];
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// PATCH /api/issues/reorder — batch kanban reorder/status-change (issues:edit)
// Body: { items: [{ id, status, sort_order }] }
export async function PATCH(req: NextRequest) {
  try {
    await requirePermission('issues', 'edit');
  } catch (err) {
    const r = authErrorResponse(err);
    if (r) return r;
    throw err;
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'invalid_json' }, { status: 400 });
  }

  const rawItems = (body as { items?: unknown })?.items;
  if (!Array.isArray(rawItems)) {
    return NextResponse.json({ error: 'invalid_items' }, { status: 400 });
  }
  if (rawItems.length > 500) {
    return NextResponse.json({ error: 'too_many_items' }, { status: 400 });
  }

  const items: IssueReorderItem[] = [];
  for (const it of rawItems) {
    if (!it || typeof it !== 'object') {
      return NextResponse.json({ error: 'invalid_item' }, { status: 400 });
    }
    const rec = it as Record<string, unknown>;
    const id = typeof rec.id === 'string' ? rec.id : '';
    const status = typeof rec.status === 'string' ? rec.status : '';
    const sortOrder = typeof rec.sort_order === 'number' ? rec.sort_order : NaN;
    if (!UUID_RE.test(id)) return NextResponse.json({ error: 'invalid_id' }, { status: 400 });
    if (!STATUSES.includes(status as IssueStatus)) {
      return NextResponse.json({ error: 'invalid_status' }, { status: 400 });
    }
    if (!Number.isInteger(sortOrder) || sortOrder < 0) {
      return NextResponse.json({ error: 'invalid_sort_order' }, { status: 400 });
    }
    items.push({ id, status, sort_order: sortOrder });
  }

  try {
    await reorderIssues(items);
    return NextResponse.json({ ok: true, updated: items.length });
  } catch (err) {
    console.error('[PATCH /api/issues/reorder]', err);
    return NextResponse.json({ error: 'server_error' }, { status: 500 });
  }
}
