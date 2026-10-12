'use client';

// תקלות/משימות — board view, desktop only (the screen falls back to the list
// below `lg`). Lanes = primary assignee (one per employee + one combined
// "ספקים" lane), NOT status — status has no chip on the card at all now
// (12/10/2026 pixel-exact adoption of ref/issues-board.html; see DESIGN.md
// §41). Native HTML5 drag only (no touch — this view never renders under `lg`).
//
// Drag semantics (unchanged since 11/10/2026):
//   - card dropped on a DIFFERENT lane → reassignment (onAssign)
//   - card dropped within its OWN lane, among cards of the SAME priority tier
//     → manual reorder (onReorder) — sort_index, never renumbers siblings
//   - a card can never be dropped across priority tiers within the same lane;
//     the drop is rejected (treated as "no-op") when tiers differ.
//   - a card dragged OUT of "ממתינים לשיבוץ" into a lane → assignment, same
//     as dropping on the lane's "שיבוץ" button (ref `.ucard`).

import { useMemo, useState } from 'react';
import { ChevronDown } from 'lucide-react';
import { cn } from '@/lib/utils';
import { landingAboveIn } from '@/lib/dnd/landing';
import { avatarColorFor, SUPPLIER_LANE_COLOR } from '@/lib/constants/workItems';
import { WorkItemCard } from './WorkItemCard';
import type { WorkItem } from '@/lib/types/workItems';

const ID_ATTR = 'data-work-item-id';

interface Lane {
  key: string;
  label: string;
  color: string;
  assignee: { kind: 'user' | 'supplier'; id: string } | null;
}

function laneKeyFor(item: WorkItem): string {
  if (!item.assignee) return 'unassigned';
  if (item.assignee.kind === 'supplier') return 'suppliers';
  return `user:${item.assignee.id}`;
}

export function WorkItemsBoard({
  items,
  canEdit,
  employees,
  suppliers,
  hasSupplierItems,
  onOpen,
  onAssign,
  onReorder,
  onMarkDone,
  onBlockedClick,
  onDelete,
}: {
  items: WorkItem[];
  canEdit: boolean;
  employees: { id: string; name: string }[];
  suppliers: { id: string; display_name: string }[];
  hasSupplierItems: boolean;
  onOpen: (item: WorkItem) => void;
  onAssign: (item: WorkItem, assignee: { kind: 'user' | 'supplier'; id: string } | null) => void;
  onReorder: (item: WorkItem, beforeId: string | null) => void;
  onMarkDone: (item: WorkItem) => void;
  onBlockedClick: (item: WorkItem) => void;
  onDelete: (item: WorkItem) => void;
}) {
  const [dragId, setDragId] = useState<string | null>(null);
  const [landing, setLanding] = useState<{ lane: string; beforeId: string | null } | null>(null);
  const [expandedRecent, setExpandedRecent] = useState<Set<string>>(new Set());

  const lanes: Lane[] = useMemo(() => {
    const out: Lane[] = employees.map((e) => ({
      key: `user:${e.id}`, label: e.name, color: avatarColorFor(e.id), assignee: { kind: 'user' as const, id: e.id },
    }));
    if (hasSupplierItems) out.push({ key: 'suppliers', label: 'ספקים', color: SUPPLIER_LANE_COLOR, assignee: null });
    return out;
  }, [employees, hasSupplierItems]);

  const byLane = useMemo(() => {
    const m = new Map<string, WorkItem[]>();
    for (const i of items) {
      const key = laneKeyFor(i);
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

  function dragItem(): WorkItem | undefined {
    return items.find((i) => i.id === dragId);
  }

  function handleDrop(laneKey: string, laneAssignee: { kind: 'user' | 'supplier'; id: string } | null, beforeId: string | null) {
    const item = dragItem();
    setDragId(null);
    setLanding(null);
    if (!item) return;
    const sourceLane = laneKeyFor(item);
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

  function renderCard(item: WorkItem, variant: 'card' | 'ucard' = 'card') {
    return (
      <WorkItemCard
        key={`${item.kind}:${item.id}`}
        item={item}
        canEdit={canEdit}
        employees={employees}
        suppliers={suppliers}
        variant={variant}
        onOpen={() => onOpen(item)}
        onAssign={(a) => onAssign(item, a)}
        onMarkDone={() => onMarkDone(item)}
        onBlockedClick={() => onBlockedClick(item)}
        onDelete={() => onDelete(item)}
        draggable={canEdit}
        ring={landing?.beforeId === item.id}
        onDragStart={(e) => {
          e.dataTransfer.setData('application/x-work-item', item.id);
          e.dataTransfer.effectAllowed = 'move';
          setDragId(item.id);
        }}
        onDragEnd={() => { setDragId(null); setLanding(null); }}
      />
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
          'flex w-[255px] shrink-0 flex-col rounded-2xl bg-[#EEF0F7] transition-colors',
          landing?.lane === lane.key ? 'ring-2 ring-brand/40' : '',
        )}
        style={{ height: 'calc(100vh - 320px)', minHeight: 340 }}
      >
        <div className="flex items-center gap-2 px-3 pb-2 pt-[11px]">
          <span
            className="grid h-7 w-7 shrink-0 place-items-center rounded-full text-[11.5px] font-bold text-white"
            style={{ background: lane.color }}
          >
            {lane.label.slice(0, 2)}
          </span>
          <h3 className="min-w-0 flex-1 truncate text-[13.5px] font-bold text-ink">{lane.label}</h3>
          <span className="rounded-full border border-line bg-white px-1.5 text-[12px] font-num font-semibold text-ink-3">
            {open.length}
          </span>
        </div>
        <div className="flex flex-1 flex-col gap-2 overflow-y-auto px-2 pb-2">
          {open.length === 0 && <p className="py-6 text-center text-[12.5px] text-ink-ghost">אין משימות פתוחות</p>}
          {open.map((i) => renderCard(i))}
        </div>
        {closed.length > 0 && (
          <div className="px-1 pb-1">
            <button
              type="button"
              onClick={() => setExpandedRecent((s) => {
                const next = new Set(s);
                if (next.has(lane.key)) next.delete(lane.key); else next.add(lane.key);
                return next;
              })}
              className="flex w-full items-center justify-center gap-1.5 rounded-lg px-2 py-1.5 text-[12px] font-semibold text-ink-3 transition-colors hover:bg-white hover:text-brand"
            >
              <ChevronDown className={cn('h-3.5 w-3.5 transition-transform', isCollapsed && '-rotate-90')} />
              נסגרו לאחרונה (7 ימים) · <span className="font-num">{closed.length}</span>
            </button>
            {!isCollapsed && <div className="mt-1 flex flex-col gap-2 opacity-70">{closed.map((i) => renderCard(i))}</div>}
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-3">
      {/* "ממתינים לשיבוץ" — full-width dashed strip, ref `.unassigned`/`.ucard`. */}
      <div
        data-lane="unassigned"
        onDragOver={(e) => {
          if (!canEdit || !dragId) return;
          e.preventDefault();
          setLanding((l) => (l?.lane === 'unassigned' ? l : { lane: 'unassigned', beforeId: null }));
        }}
        onDrop={(e) => { e.preventDefault(); if (canEdit && dragId) handleDrop('unassigned', null, null); }}
        className={cn(
          'flex flex-wrap items-center gap-3.5 rounded-2xl border-[1.5px] border-dashed p-3.5 transition-colors',
          landing?.lane === 'unassigned' ? 'border-brand/50 bg-brand-soft/60' : 'border-[#FBE4B5] bg-[#FFFDF6]',
        )}
      >
        <div className="flex shrink-0 items-center gap-2 text-[14px] font-bold text-[#945700]">
          ממתינים לשיבוץ
          <span className="rounded-full border border-[#FBE4B5] bg-[#FFF6E6] px-2 py-0.5 text-[12px] font-num font-bold">
            {unassigned.length}
          </span>
          {unassigned.some((i) => i.priority === 'urgent') && (
            <span className="rounded-full bg-rose-100 px-2 py-0.5 text-[12px] font-num font-bold text-rose-700">
              {unassigned.filter((i) => i.priority === 'urgent').length} דחופות
            </span>
          )}
        </div>
        {unassigned.length === 0 ? (
          <p className="text-[12.5px] text-[#945700]/60">אין פריטים ללא שיוך</p>
        ) : (
          <div className="flex min-w-0 flex-1 flex-wrap gap-2">
            {unassigned.map((i) => renderCard(i, 'ucard'))}
          </div>
        )}
      </div>

      <div className="flex gap-3 overflow-x-auto pb-2.5">
        {lanes.map(renderLaneColumn)}
      </div>
    </div>
  );
}
