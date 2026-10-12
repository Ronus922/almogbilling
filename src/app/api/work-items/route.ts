import { NextResponse, type NextRequest } from 'next/server';
import { requirePermission, type Actor } from '@/lib/auth/actor';
import { authErrorResponse } from '@/lib/auth/apiGuard';
import { listWorkItems, getWorkItemKpis } from '@/lib/db/workItems';
import type { WorkItemKind, WorkItemListFilters, WorkItemViewTab } from '@/lib/types/workItems';

export const runtime = 'nodejs';

const TABS: readonly WorkItemViewTab[] = ['active', 'recurring', 'archive'];
const KINDS: readonly WorkItemKind[] = ['issue', 'task'];

// GET /api/work-items?kind=issue|task&tab&priority&assigneeUserId&search&kpis
// The תקלות (issues) and משימות (tasks) screens' list/board feed — `kind` is
// REQUIRED and selects which single table this call reads; the two screens
// share this route as an implementation detail (same query shape, same scope
// logic — src/lib/db/workItems.ts), never a query spanning both tables (12/10/
// 2026, Decisions Log: "עיצוב משותף, ישויות נפרדות"). (tasks:view | issues:view,
// matching `kind`)
export async function GET(req: NextRequest) {
  const sp = req.nextUrl.searchParams;

  const kindRaw = sp.get('kind')?.trim();
  if (!kindRaw || !KINDS.includes(kindRaw as WorkItemKind)) {
    return NextResponse.json({ error: 'kind_required' }, { status: 400 });
  }
  const kind = kindRaw as WorkItemKind;

  let actor: Actor;
  try {
    actor = await requirePermission(kind === 'issue' ? 'issues' : 'tasks', 'view');
  } catch (err) {
    const r = authErrorResponse(err);
    if (r) return r;
    throw err;
  }

  const tabRaw = sp.get('tab')?.trim();
  const tab: WorkItemViewTab = tabRaw && TABS.includes(tabRaw as WorkItemViewTab) ? (tabRaw as WorkItemViewTab) : 'active';

  const priorityRaw = sp.get('priority')?.trim();
  const priority =
    priorityRaw && ['normal', 'high', 'urgent'].includes(priorityRaw)
      ? (priorityRaw as 'normal' | 'high' | 'urgent')
      : undefined;

  const assigneeUserIdRaw = sp.get('assigneeUserId')?.trim();
  const assigneeUserId = assigneeUserIdRaw || undefined;

  const search = sp.get('search')?.trim() || undefined;

  const filters: WorkItemListFilters = { tab, priority, assigneeUserId, search };
  const items = await listWorkItems(kind, filters, actor);

  if (sp.get('kpis') === '1') {
    const kpis = await getWorkItemKpis(kind, actor);
    return NextResponse.json({ items, kpis });
  }
  return NextResponse.json({ items });
}
