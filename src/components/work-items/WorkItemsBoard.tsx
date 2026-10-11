'use client';

// Unified תקלות/משימות module (11/10/2026) — board view, desktop only (the
// page falls back to the list below `lg`). Lanes = primary assignee (one per
// employee + one for suppliers), NOT status — status is a chip on the card.
// Native HTML5 drag only (no touch — this view never renders under `lg`).
//
// Drag semantics (decision 11/10/2026):
//   - card dropped on a DIFFERENT lane → reassignment (onAssign)
//   - card dropped within its OWN lane, among cards of the SAME priority tier
//     → manual reorder (onReorder) — sort_index, never renumbers siblings
//   - a card can never be dropped across priority tiers within the same lane;
//     the drop is rejected (treated as "no-op") when tiers differ.

import { useMemo, useState } from 'react';
import { AlertOctagon, ChevronDown } from 'lucide-react';
import { cn } from '@/lib/utils';
import { landingAboveIn } from '@/lib/dnd/landing';
import {
  WORK_PRIORITY_TAG, WORK_PRIORITY_LABEL, WORK_STATUS_DOT, WORK_STATUS_LABEL,
  WORK_NEW_TAG, WORK_BLOCKED_TAG, WORK_RESIDENT_TAG, WORK_KIND_TAG, WORK_KIND_LABEL,
} from '@/lib/constants/workItems';
import { BlockedToggleDialog } from './BlockedToggleDialog';
import type { WorkItem } from '@/lib/types/workItems';

const ID_ATTR = 'data-work-item-id';

interface Lane {
  key: string;
  label: string;
  assignee: { kind: 'user' | 'supplier'; id: string } | null;
}

function laneKeyFor(item: WorkItem): string {
  if (!item.assignee) return 'unassigned';
  return `${item.assignee.kind}:${item.assignee.id}`;
}

export function WorkItemsBoard({
  items,
  canEdit,
  employees,
  hasSupplierItems,
  onOpen,
  onAssign,
  onReorder,
  onAdvanceStatus,
  onBlockedChange,
}: {
  items: WorkItem[];
  canEdit: boolean;
  employees: { id: string; name: string }[];
  hasSupplierItems: boolean;
  onOpen: (item: WorkItem) => void;
  onAssign: (item: WorkItem, assignee: { kind: 'user' | 'supplier'; id: string } | null) => void;
  onReorder: (item: WorkItem, beforeId: string | null) => void;
  onAdvanceStatus: (item: WorkItem) => void;
  onBlockedChange: (item: WorkItem, blocked: boolean, reason: string | null) => void;
}) {
  const [dragId, setDragId] = useState<string | null>(null);
  const [blockedDialogItem, setBlockedDialogItem] = useState<WorkItem | null>(null);
  const [landing, setLanding] = useState<{ lane: string; beforeId: string | null } | null>(null);
  const [expandedRecent, setRecentCollapsed] = useState<Set<string>>(new Set());

  const lanes: Lane[] = useMemo(() => {
    const out: Lane[] = [...employees.map((e) => ({ key: `user:${e.id}`, label: e.name, assignee: { kind: 'user' as const, id: e.id } }))];
    if (hasSupplierItems) out.push({ key: 'suppliers', label: 'ספקים', assignee: null });
    return out;
  }, [employees, hasSupplierItems]);

  const byLane = useMemo(() => {
    const m = new Map<string, WorkItem[]>();
    for (const i of items) {
      const key = i.assignee?.kind === 'supplier' ? 'suppliers' : laneKeyFor(i);
      const arr = m.get(key) ?? [];
      arr.push(i);
      m.set(key, arr);
    }
    const rank = (p: WorkItem['priority']) => (p === 'urgent' ? 0 : p === 'high' ? 1 : 2);
    for (const arr of m.values()) {
      arr.sort((a, b) => {
        if (a.status_v2 === 'closed' && b.status_v2 !== 'closed') return 1;
        if (b.status_v2 === 'closed' && a.status_v2 !== 'closed') return -1;
        const pr = rank(a.priority) - rank(b.priority);
        if (pr !== 0) return pr;
        if (a.sort_index !== null && b.sort_index !== null && a.sort_index !== b.sort_index) return a.sort_index - b.sort_index;
        if (a.due_date !== b.due_date) return (a.due_date ?? '9999') < (b.due_date ?? '9999') ? -1 : 1;
        return a.created_at < b.created_at ? 1 : -1;
      });
    }
    return m;
  }, [items]);

  const unassigned = byLane.get('unassigned') ?? [];

  // dragId is the bare item id (UUIDs are unique across issues+tasks in
  // practice) — kept bare so a landed `beforeId` is a valid `before_id` for
  // the per-kind move endpoint (/api/work-items/[kind]/[id]/move), which
  // rejects anything that isn't a plain UUID.
  function dragItem(): WorkItem | undefined {
    return items.find((i) => i.id === dragId);
  }

  function handleDrop(laneKey: string, laneAssignee: { kind: 'user' | 'supplier'; id: string } | null, beforeId: string | null) {
    const item = dragItem();
    setDragId(null);
    setLanding(null);
    if (!item) return;
    const sourceLane = item.assignee?.kind === 'supplier' ? 'suppliers' : laneKeyFor(item);
    if (sourceLane !== laneKey) {
      onAssign(item, laneAssignee);
      return;
    }
    // Same lane: only a same-priority-tier reorder is allowed.
    const siblings = byLane.get(laneKey) ?? [];
    const before = beforeId ? siblings.find((s) => s.id === beforeId) : null;
    if (before && before.priority !== item.priority) return; // cross-tier — no-op
    onReorder(item, beforeId);
  }

  function renderCard(item: WorkItem) {
    return (
      <div
        key={`${item.kind}:${item.id}`}
        data-work-item-id={item.id}
        draggable={canEdit}
        onDragStart={(e) => {
          e.dataTransfer.setData('application/x-work-item', item.id);
          e.dataTransfer.effectAllowed = 'move';
          setDragId(item.id);
        }}
        onDragEnd={() => { setDragId(null); setLanding(null); }}
        onClick={() => onOpen(item)}
        role="button"
        tabIndex={0}
        onKeyDown={(e) => { if (e.key === 'Enter') onOpen(item); }}
        className={cn(
          'cursor-pointer rounded-xl border bg-white p-3 text-start shadow-[0_1px_2px_rgba(15,23,42,0.04)] transition-colors hover:border-slate-300',
          item.priority === 'urgent' && 'border-rose-300 bg-rose-50',
          item.priority === 'high' && 'border-amber-300 bg-amber-50',
          item.priority === 'normal' && 'border-slate-200',
          landing?.beforeId === item.id && 'ring-2 ring-blue-300',
        )}
      >
        <div className="flex flex-wrap items-center gap-1">
          {item.is_new && <span className={cn('rounded-md px-1.5 py-0.5 text-[10px] font-bold', WORK_NEW_TAG)}>חדש</span>}
          {WORK_PRIORITY_TAG[item.priority] && (
            <span className={cn('rounded-md px-1.5 py-0.5 text-[10px] font-bold', WORK_PRIORITY_TAG[item.priority])}>
              {WORK_PRIORITY_LABEL[item.priority]}
            </span>
          )}
          <span className={cn('rounded-md px-1.5 py-0.5 text-[10px] font-bold', WORK_KIND_TAG[item.kind])}>
            {WORK_KIND_LABEL[item.kind]}
          </span>
          {item.blocked && (
            <button
              type="button"
              disabled={!canEdit}
              onClick={(e) => { e.stopPropagation(); setBlockedDialogItem(item); }}
              className={cn('rounded-md px-1.5 py-0.5 text-[10px] font-bold', WORK_BLOCKED_TAG)}
            >
              תקוע
            </button>
          )}
          {item.is_from_resident && <span className={cn('rounded-md px-1.5 py-0.5 text-[10px] font-bold', WORK_RESIDENT_TAG)}>דייר</span>}
        </div>
        <h4 className="mt-1 line-clamp-2 text-[13.5px] font-bold text-slate-900">{item.title}</h4>
        <div className="mt-2 flex items-center justify-between gap-2">
          {item.due_date ? (
            <span dir="ltr" className="text-[11px] tabular-nums text-slate-500">{item.due_date.slice(5)}</span>
          ) : <span />}
          <div className="flex items-center gap-1">
            {canEdit && !item.blocked && (
              <button
                type="button"
                aria-label="סמן כתקוע"
                onClick={(e) => { e.stopPropagation(); setBlockedDialogItem(item); }}
                className="grid h-6 w-6 place-items-center rounded-full text-slate-400 hover:bg-red-50 hover:text-red-600"
              >
                <AlertOctagon className="h-3.5 w-3.5" />
              </button>
            )}
            <button
              type="button"
              disabled={!canEdit || item.status_v2 === 'closed'}
              onClick={(e) => { e.stopPropagation(); onAdvanceStatus(item); }}
              className="inline-flex items-center gap-1 rounded-full bg-slate-100 px-2 py-0.5 text-[10.5px] font-semibold text-slate-700 disabled:cursor-default"
            >
              <span className={cn('h-1.5 w-1.5 rounded-full', WORK_STATUS_DOT[item.status_v2])} />
              {WORK_STATUS_LABEL[item.status_v2]}
            </button>
          </div>
        </div>
      </div>
    );
  }

  function renderLaneColumn(lane: Lane) {
    const all = byLane.get(lane.key) ?? [];
    const open = all.filter((i) => i.status_v2 !== 'closed');
    const closed = all.filter((i) => i.status_v2 === 'closed');
    const isCollapsed = !expandedRecent.has(lane.key); // default collapsed

    return (
      <div
        key={lane.key}
        data-lane={lane.key}
        onDragOver={(e) => {
          if (!canEdit || !dragId) return;
          e.preventDefault();
          const beforeId = landingAboveIn(e.currentTarget, e.clientY, dragId, ID_ATTR);
          setLanding((l) => (l?.lane === lane.key && l.beforeId === beforeId ? l : { lane: lane.key, beforeId }));
        }}
        onDrop={(e) => {
          e.preventDefault();
          if (!canEdit || !dragId) return;
          const beforeId = landingAboveIn(e.currentTarget, e.clientY, dragId, ID_ATTR);
          handleDrop(lane.key, lane.assignee, beforeId);
        }}
        className={cn(
          'flex min-h-[200px] flex-col rounded-2xl border bg-slate-100 p-3',
          landing?.lane === lane.key ? 'border-blue-300 bg-blue-50/60' : 'border-slate-200',
        )}
      >
        <div className="mb-2 flex items-center justify-between px-1">
          <h3 className="truncate text-[13px] font-bold text-slate-700">{lane.label}</h3>
          <span className="rounded-md bg-white px-1.5 text-[11px] font-bold text-slate-500">{open.length}</span>
        </div>
        <div className="flex flex-1 flex-col gap-2">
          {open.length === 0 && <p className="py-6 text-center text-[12px] text-slate-400">ריק</p>}
          {open.map(renderCard)}
        </div>
        {closed.length > 0 && (
          <div className="mt-2 border-t border-slate-200 pt-2">
            <button
              type="button"
              onClick={() => setRecentCollapsed((s) => {
                const next = new Set(s);
                if (next.has(lane.key)) next.delete(lane.key); else next.add(lane.key);
                return next;
              })}
              className="flex w-full items-center gap-1.5 px-1 text-[11px] font-semibold text-slate-500"
            >
              <ChevronDown className={cn('h-3.5 w-3.5 transition-transform', isCollapsed && '-rotate-90')} />
              נסגרו לאחרונה (7 ימים) · {closed.length}
            </button>
            {!isCollapsed && <div className="mt-2 flex flex-col gap-2 opacity-70">{closed.map(renderCard)}</div>}
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {/* "ממתינים לשיבוץ" — full-width strip */}
      <div
        data-lane="unassigned"
        onDragOver={(e) => {
          if (!canEdit || !dragId) return;
          e.preventDefault();
          setLanding((l) => (l?.lane === 'unassigned' ? l : { lane: 'unassigned', beforeId: null }));
        }}
        onDrop={(e) => { e.preventDefault(); if (canEdit && dragId) handleDrop('unassigned', null, null); }}
        className={cn(
          'rounded-2xl border-2 border-dashed p-3',
          landing?.lane === 'unassigned' ? 'border-blue-300 bg-blue-50/60' : 'border-amber-300 bg-amber-50/40',
        )}
      >
        <div className="mb-2 flex items-center gap-2 px-1">
          <h3 className="text-[13px] font-bold text-amber-800">ממתינים לשיבוץ</h3>
          <span className="rounded-md bg-white px-1.5 text-[11px] font-bold text-amber-700">{unassigned.length}</span>
          {unassigned.some((i) => i.priority === 'urgent') && (
            <span className="rounded-md bg-rose-100 px-1.5 text-[11px] font-bold text-rose-700">
              {unassigned.filter((i) => i.priority === 'urgent').length} דחופות
            </span>
          )}
        </div>
        {unassigned.length === 0 ? (
          <p className="py-4 text-center text-[12px] text-amber-700/60">אין פריטים ללא שיוך</p>
        ) : (
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-4">
            {unassigned.map(renderCard)}
          </div>
        )}
      </div>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-[repeat(auto-fit,minmax(220px,1fr))]">
        {lanes.map(renderLaneColumn)}
      </div>

      {blockedDialogItem && (
        <BlockedToggleDialog
          open
          onOpenChange={(o) => { if (!o) setBlockedDialogItem(null); }}
          kind={blockedDialogItem.kind}
          id={blockedDialogItem.id}
          currentlyBlocked={blockedDialogItem.blocked}
          currentReason={blockedDialogItem.blocked_reason}
          onDone={(blocked, reason) => {
            onBlockedChange(blockedDialogItem, blocked, reason);
            setBlockedDialogItem(null);
          }}
        />
      )}
    </div>
  );
}
