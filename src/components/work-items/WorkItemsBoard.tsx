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
import { ChevronDown, Plus, UserPlus } from 'lucide-react';
import { cn } from '@/lib/utils';
import { landingAboveIn } from '@/lib/dnd/landing';
import { avatarColorFor, SUPPLIER_LANE_COLOR, SUPPLIERS_LANE_ID } from '@/lib/constants/workItems';
import { WorkItemCard } from './WorkItemCard';
import type { BoardLaneTarget, WorkItem } from '@/lib/types/workItems';

const ID_ATTR = 'data-work-item-id';

interface Lane {
  key: string;
  label: string;
  color: string;
  assignee: { kind: 'user' | 'supplier'; id: string } | null;
}

function laneKeyFor(item: WorkItem): string {
  if (!item.assignee) return 'unassigned';
  if (item.assignee.kind === 'supplier') return SUPPLIERS_LANE_ID;
  return `user:${item.assignee.id}`;
}

export function WorkItemsBoard({
  items,
  canEdit,
  employees,
  suppliers,
  laneOrder,
  noun,
  onOpen,
  onAssign,
  onAddToLane,
  onReorder,
  onReorderLanes,
  onMarkDone,
  onBlockedClick,
  onDelete,
}: {
  items: WorkItem[];
  canEdit: boolean;
  /** The full resolved employee lane roster, in the caller's order — used
   *  both to render `user:*` lanes (filtered/ordered by `laneOrder` below)
   *  and, unrelated to lane visibility, as the assignee-picker roster on
   *  every card. */
  employees: { id: string; name: string }[];
  suppliers: { id: string; display_name: string }[];
  /** Which lanes to render and in what order (14/10/2026, "התאמת לוח —
   *  ספקים + בחירה מפורשת גוברת") — employee ids plus, optionally,
   *  SUPPLIERS_LANE_ID for the combined "ספקים" lane. Default-computed or
   *  already customized; the caller (WorkEntityScreen) owns that decision,
   *  this component only renders the result. */
  laneOrder: string[];
  /** "משימה" / "תקלה" — the lane "+" tooltip ("הוסף {noun} ל{שם}"). */
  noun: string;
  onOpen: (item: WorkItem) => void;
  onAssign: (item: WorkItem, assignee: { kind: 'user' | 'supplier'; id: string } | null) => void;
  /** Lane header "+" (19/10/2026) — open the create form for this lane. */
  onAddToLane: (target: BoardLaneTarget) => void;
  onReorder: (item: WorkItem, beforeId: string | null) => void;
  /** A lane header was dragged into this new position (13/10/2026, "התאמת
   *  לוח" decision 2; extended 14/10/2026 to include the suppliers lane) —
   *  the full lane id list (employee uuids + optionally SUPPLIERS_LANE_ID),
   *  in the new display order. The caller persists it as-is. */
  onReorderLanes?: (newLaneIds: string[]) => void;
  onMarkDone: (item: WorkItem) => void;
  onBlockedClick: (item: WorkItem) => void;
  onDelete: (item: WorkItem) => void;
}) {
  const [dragId, setDragId] = useState<string | null>(null);
  const [landing, setLanding] = useState<{ lane: string; beforeId: string | null } | null>(null);
  const [laneDragKey, setLaneDragKey] = useState<string | null>(null);
  const [laneLanding, setLaneLanding] = useState<string | null>(null);
  const [expandedRecent, setExpandedRecent] = useState<Set<string>>(new Set());

  const lanes: Lane[] = useMemo(() => {
    const byId = new Map(employees.map((e) => [e.id, e]));
    const out: Lane[] = [];
    for (const id of laneOrder) {
      if (id === SUPPLIERS_LANE_ID) {
        out.push({ key: SUPPLIERS_LANE_ID, label: 'ספקים', color: SUPPLIER_LANE_COLOR, assignee: null });
        continue;
      }
      const e = byId.get(id);
      if (e) out.push({ key: `user:${e.id}`, label: e.name, color: avatarColorFor(e.id), assignee: { kind: 'user' as const, id: e.id } });
    }
    return out;
  }, [employees, laneOrder]);

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
        // A real sort_index always outranks a never-positioned (null) sibling
        // — nulls last, same as the server's own ORDER BY. Comparing only
        // when BOTH sides are non-null (as this used to) silently drops a
        // genuine position whenever the other side is still null, falling
        // through to the due_date/created_at tiebreak instead.
        if (a.sort_index !== b.sort_index) {
          if (a.sort_index === null) return 1;
          if (b.sort_index === null) return -1;
          return a.sort_index - b.sort_index;
        }
        if (a.due_date !== b.due_date) return (a.due_date ?? '9999') < (b.due_date ?? '9999') ? -1 : 1;
        return a.created_at < b.created_at ? 1 : -1;
      });
    }
    return m;
  }, [items]);

  const unassigned = byLane.get('unassigned') ?? [];
  const urgentUnassigned = unassigned.filter((i) => i.priority === 'urgent').length;

  function dragItem(): WorkItem | undefined {
    return items.find((i) => i.id === dragId);
  }

  // Lane header drag (13/10/2026, "התאמת לוח" decision 2) — a SEPARATE drag
  // channel from card drag (own state, own data-transfer type), so dragging a
  // card over a header never reorders lanes and vice versa. Horizontal, RTL:
  // the lanes row is a plain flex row under dir="rtl", so DOM order renders
  // right-to-left — the first lane is the rightmost. "Before" in DOM/array
  // order therefore sits to the pointer's right, the mirror image of
  // landingAboveIn's vertical (always top-to-bottom, RTL-independent) rule.
  function laneLandingBefore(container: HTMLElement, x: number, skipKey: string): string | null {
    for (const el of container.querySelectorAll<HTMLElement>('[data-lane]')) {
      const key = el.getAttribute('data-lane');
      if (!key || key === skipKey) continue;
      const r = el.getBoundingClientRect();
      if (x > r.left + r.width / 2) return key;
    }
    return null;
  }

  function dropLane(beforeKey: string | null) {
    const draggedKey = laneDragKey;
    setLaneDragKey(null);
    setLaneLanding(null);
    if (!draggedKey || !onReorderLanes || draggedKey === beforeKey) return;
    // Lane keys carry the `user:` prefix (laneKeyFor/the `lanes` useMemo
    // above), except the suppliers sentinel, which has none — reorder on the
    // prefixed/raw keys as rendered, strip only the `user:` prefix for the
    // callback, which deals in raw lane ids (employee uuids + optionally
    // SUPPLIERS_LANE_ID).
    const keys = lanes.map((l) => l.key);
    const from = keys.indexOf(draggedKey);
    if (from === -1) return;
    const without = keys.filter((k) => k !== draggedKey);
    const toIdx = beforeKey ? without.indexOf(beforeKey) : without.length;
    if (beforeKey && toIdx === -1) return;
    const newKeys = [...without.slice(0, toIdx), draggedKey, ...without.slice(toIdx)];
    onReorderLanes(newKeys.map((k) => (k === SUPPLIERS_LANE_ID ? k : k.slice('user:'.length))));
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
          'flex min-h-[340px] w-[255px] shrink-0 flex-col rounded-[14px] bg-[#EEF0F7] transition-colors',
          landing?.lane === lane.key ? 'ring-2 ring-brand/40' : '',
          laneLanding === lane.key && 'ring-2 ring-brand/60',
          laneDragKey === lane.key && 'opacity-50',
        )}
      >
        <div
          data-lane-handle={lane.key}
          className={cn(
            'flex items-center gap-2 px-3 pb-2 pt-[11px]',
            canEdit && onReorderLanes && 'cursor-grab active:cursor-grabbing',
          )}
          draggable={canEdit && !!onReorderLanes}
          onDragStart={(e) => {
            e.stopPropagation();
            e.dataTransfer.setData('application/x-work-lane', lane.key);
            e.dataTransfer.effectAllowed = 'move';
            setLaneDragKey(lane.key);
          }}
          onDragEnd={() => { setLaneDragKey(null); setLaneLanding(null); }}
        >
          <span
            className="grid h-7 w-7 shrink-0 place-items-center rounded-full text-[11.5px] font-bold text-white"
            style={{ background: lane.color }}
          >
            {lane.label.slice(0, 2)}
          </span>
          <h3 className="min-w-0 flex-1 truncate text-[13.5px] font-bold text-ink">{lane.label}</h3>
          {canEdit && (
            <button
              type="button"
              data-add-lane={lane.key}
              title={`הוסף ${noun} ל${lane.label}`}
              aria-label={`הוסף ${noun} ל${lane.label}`}
              draggable={false}
              onClick={(e) => {
                e.stopPropagation();
                onAddToLane(lane.assignee ? { kind: 'user', id: lane.assignee.id } : { kind: 'supplier' });
              }}
              className="grid h-[26px] w-[26px] shrink-0 cursor-pointer place-items-center rounded-[7px] text-ink-ghost transition-[background-color,color,box-shadow] duration-150 hover:bg-white hover:text-brand hover:shadow-[0_1px_3px_rgba(20,28,50,0.08)]"
            >
              <Plus className="h-[15px] w-[15px]" strokeWidth={2.2} />
            </button>
          )}
          <span className="rounded-full border border-line bg-white px-2 py-0.5 text-[12px] font-num font-semibold text-ink-3">
            {open.length}
          </span>
        </div>
        <div className="wb-cbody flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto px-2 pb-2">
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
      {/* "ממתינים לשיבוץ" — block strip, title row (.uh) above a full-width card
          row (.ucards); not rendered at all when empty (19/10/2026,
          ref/Kanva-issue) and back as soon as an unassigned item exists. */}
      {unassigned.length > 0 && (
        <div
          data-lane="unassigned"
          onDragOver={(e) => {
            if (!canEdit || !dragId) return;
            e.preventDefault();
            setLanding((l) => (l?.lane === 'unassigned' ? l : { lane: 'unassigned', beforeId: null }));
          }}
          onDrop={(e) => { e.preventDefault(); if (canEdit && dragId) handleDrop('unassigned', null, null); }}
          className={cn(
            'block rounded-[14px] border-[1.5px] border-dashed px-4 pb-3.5 pt-3 transition-colors',
            landing?.lane === 'unassigned' ? 'border-brand/50 bg-brand-soft/60' : 'border-[#FBE4B5] bg-[#FFFDF6]',
          )}
        >
          <div className="mb-2.5 flex items-center gap-[9px] text-[14px] font-bold text-[#945700]">
            <UserPlus className="h-4 w-4 shrink-0" />
            <span>ממתינים לשיבוץ</span>
            <span data-unassigned-count className="rounded-full border border-[#FBE4B5] bg-white px-2 py-0.5 text-[12px] font-num font-bold">
              {unassigned.length}
            </span>
            {urgentUnassigned > 0 && (
              <span data-unassigned-urgent className="whitespace-nowrap rounded-full border border-[#F8D2D3] bg-[#FEEFEF] px-[9px] py-0.5 text-[12px] font-bold text-[#B01B20]">
                {urgentUnassigned} דחופות
              </span>
            )}
          </div>
          <div className="flex flex-wrap gap-[9px]">
            {unassigned.map((i) => renderCard(i, 'ucard'))}
          </div>
        </div>
      )}

      <div
        data-board-lanes
        className="flex h-[80vh] flex-none items-stretch gap-3 overflow-x-auto pb-2.5"
        onDragOver={(e) => {
          if (!laneDragKey) return;
          e.preventDefault();
          const beforeKey = laneLandingBefore(e.currentTarget, e.clientX, laneDragKey);
          setLaneLanding((l) => (l === beforeKey ? l : beforeKey));
        }}
        onDrop={(e) => { e.preventDefault(); if (laneDragKey) dropLane(laneLandingBefore(e.currentTarget, e.clientX, laneDragKey)); }}
      >
        {lanes.map(renderLaneColumn)}
      </div>
    </div>
  );
}
