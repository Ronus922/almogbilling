import { NextResponse, type NextRequest } from 'next/server';
import { requireAnyPermission, type Actor } from '@/lib/auth/actor';
import { authErrorResponse } from '@/lib/auth/apiGuard';
import { listWorkItems, getWorkItemKpis } from '@/lib/db/workItems';
import type { WorkItemKind, WorkItemListFilters, WorkItemViewTab } from '@/lib/types/workItems';

export const runtime = 'nodejs';

const TABS: readonly WorkItemViewTab[] = ['active', 'recurring', 'archive'];
const KINDS: readonly WorkItemKind[] = ['issue', 'task'];

// GET /api/work-items?tab&kind&priority&assigneeUserId&search&kpis  (tasks:view OR issues:view)
// The unified תקלות/משימות list/board feed — read-only, combining `issues` and
// `tasks` (src/lib/db/workItems.ts). Row-level scope (workItemScopeSql)
// REPLACES the issues-only issueScopeUserId scoping for this screen — see
// Decisions Log 11/10/2026.
export async function GET(req: NextRequest) {
  let actor: Actor;
  try {
    actor = await requireAnyPermission([
      { module: 'tasks', action: 'view' },
      { module: 'issues', action: 'view' },
    ]);
  } catch (err) {
    const r = authErrorResponse(err);
    if (r) return r;
    throw err;
  }

  const sp = req.nextUrl.searchParams;

  const tabRaw = sp.get('tab')?.trim();
  const tab: WorkItemViewTab = tabRaw && TABS.includes(tabRaw as WorkItemViewTab) ? (tabRaw as WorkItemViewTab) : 'active';

  const kindRaw = sp.get('kind')?.trim();
  const kind = kindRaw && KINDS.includes(kindRaw as WorkItemKind) ? (kindRaw as WorkItemKind) : undefined;

  const priorityRaw = sp.get('priority')?.trim();
  const priority =
    priorityRaw && ['normal', 'high', 'urgent'].includes(priorityRaw)
      ? (priorityRaw as 'normal' | 'high' | 'urgent')
      : undefined;

  const assigneeUserIdRaw = sp.get('assigneeUserId')?.trim();
  const assigneeUserId = assigneeUserIdRaw || undefined;

  const search = sp.get('search')?.trim() || undefined;

  const filters: WorkItemListFilters = { tab, kind, priority, assigneeUserId, search };
  const items = await listWorkItems(filters, actor);

  if (sp.get('kpis') === '1') {
    const kpis = await getWorkItemKpis(actor);
    return NextResponse.json({ items, kpis });
  }
  return NextResponse.json({ items });
}
