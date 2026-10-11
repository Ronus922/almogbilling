'use client';

// Unified תקלות/משימות module (11/10/2026) — grouped list view (default).
// Closed items never appear here (board collapses them instead) — "סגורות
// לא מופיעות בפעילות".

import { useMemo, useState } from 'react';
import { ChevronDown } from 'lucide-react';
import { cn } from '@/lib/utils';
import { WORK_PRIORITY_LABEL } from '@/lib/constants/workItems';
import { WorkItemRow } from './WorkItemRow';
import type { WorkItem, WorkItemGroupBy } from '@/lib/types/workItems';

interface Group {
  key: string;
  label: string;
  items: WorkItem[];
}

function priorityRank(p: WorkItem['priority']): number {
  return p === 'urgent' ? 0 : p === 'high' ? 1 : 2;
}

function groupItems(items: WorkItem[], groupBy: WorkItemGroupBy): Group[] {
  if (groupBy === 'priority') {
    const byPriority = new Map<string, WorkItem[]>();
    for (const i of items) {
      const arr = byPriority.get(i.priority) ?? [];
      arr.push(i);
      byPriority.set(i.priority, arr);
    }
    return (['urgent', 'high', 'normal'] as const)
      .filter((p) => byPriority.has(p))
      .map((p) => ({ key: p, label: WORK_PRIORITY_LABEL[p], items: byPriority.get(p)! }));
  }

  if (groupBy === 'assignee') {
    const unassigned: WorkItem[] = [];
    const suppliers: WorkItem[] = [];
    const byUser = new Map<string, { name: string; items: WorkItem[] }>();
    for (const i of items) {
      if (i.assignee === null) unassigned.push(i);
      else if (i.assignee.kind === 'supplier') suppliers.push(i);
      else {
        const g = byUser.get(i.assignee.id) ?? { name: i.assignee.display_name, items: [] };
        g.items.push(i);
        byUser.set(i.assignee.id, g);
      }
    }
    const groups: Group[] = [];
    if (unassigned.length) groups.push({ key: 'unassigned', label: 'תור קליטה — ללא שיוך', items: unassigned });
    for (const [id, g] of byUser) groups.push({ key: id, label: g.name, items: g.items });
    if (suppliers.length) groups.push({ key: 'suppliers', label: 'ספקים', items: suppliers });
    return groups;
  }

  // groupBy === 'status' (default)
  const open: WorkItem[] = [];
  const inProgress: WorkItem[] = [];
  for (const i of items) {
    (i.status_v2 === 'in_progress' ? inProgress : open).push(i);
  }
  const groups: Group[] = [];
  if (open.length) groups.push({ key: 'open', label: 'פתוחות', items: open });
  if (inProgress.length) groups.push({ key: 'in_progress', label: 'בטיפול', items: inProgress });
  return groups;
}

export function WorkItemsList({
  items,
  today,
  canEdit,
  groupBy,
  employees,
  suppliers,
  onOpen,
  onAssign,
  onAdvanceStatus,
  onBlockedChange,
}: {
  items: WorkItem[];
  today: string;
  canEdit: boolean;
  groupBy: WorkItemGroupBy;
  employees: { id: string; name: string }[];
  suppliers: { id: string; display_name: string }[];
  onOpen: (item: WorkItem) => void;
  onAssign: (item: WorkItem, assignee: { kind: 'user' | 'supplier'; id: string } | null) => void;
  onAdvanceStatus: (item: WorkItem) => void;
  onBlockedChange: (item: WorkItem, blocked: boolean, reason: string | null) => void;
}) {
  // Closed never shows in the active list (the board handles "recently closed").
  const active = useMemo(
    () => items
      .filter((i) => i.status_v2 !== 'closed')
      .sort((a, b) => {
        const pr = priorityRank(a.priority) - priorityRank(b.priority);
        if (pr !== 0) return pr;
        if (a.due_date !== b.due_date) return (a.due_date ?? '9999') < (b.due_date ?? '9999') ? -1 : 1;
        return a.created_at < b.created_at ? 1 : -1;
      }),
    [items],
  );
  const groups = useMemo(() => groupItems(active, groupBy), [active, groupBy]);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());

  if (active.length === 0) {
    return (
      <div className="rounded-2xl border border-slate-200 bg-white p-10 text-center text-sm text-slate-400">
        אין פריטים פעילים.
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {groups.map((g) => {
        const isCollapsed = collapsed.has(g.key);
        return (
          <div key={g.key}>
            <button
              type="button"
              onClick={() => setCollapsed((s) => {
                const next = new Set(s);
                if (next.has(g.key)) next.delete(g.key); else next.add(g.key);
                return next;
              })}
              className="flex w-full items-center gap-2 px-1 py-1.5 text-start"
            >
              <ChevronDown className={cn('h-4 w-4 text-slate-400 transition-transform', isCollapsed && '-rotate-90')} />
              <h3 className="text-[13px] font-extrabold text-slate-600">{g.label}</h3>
              <span className="rounded-full bg-slate-100 px-2 py-0.5 text-[11px] font-bold text-slate-500">{g.items.length}</span>
            </button>
            {!isCollapsed && (
              <div className="mt-1.5 space-y-1.5">
                {g.items.map((item) => (
                  <WorkItemRow
                    key={`${item.kind}:${item.id}`}
                    item={item}
                    today={today}
                    canEdit={canEdit}
                    employees={employees}
                    suppliers={suppliers}
                    onOpen={() => onOpen(item)}
                    onAssign={(a) => onAssign(item, a)}
                    onAdvanceStatus={() => onAdvanceStatus(item)}
                    onBlockedChange={(blocked, reason) => onBlockedChange(item, blocked, reason)}
                  />
                ))}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
