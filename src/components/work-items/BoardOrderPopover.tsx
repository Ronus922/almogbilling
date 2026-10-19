'use client';

// "התאמת לוח" (13/10/2026) — which lanes the viewer sees on their own
// /issues or /tasks board, and in what order. Opens over the toolbar button;
// every toggle/drag commits immediately (onChange), same auto-save shape as
// PrimaryAssigneePicker — no separate save/cancel. Desktop-only control for a
// desktop-only view (the board itself never renders under `lg`), so the drag
// here is native HTML5 drag and drop only, same arithmetic as the board's own
// card drag (landingAboveIn) — no long-press/touch variant needed.
//
// "ממתינים לשיבוץ" is not a row here — it is not a lane; since 19/10/2026 it shows only while something is unassigned.
// "ספקים" IS a row (14/10/2026, "התאמת לוח — ספקים + בחירה מפורשת גוברת"),
// appended to the roster below as a synthetic entry under SUPPLIERS_LANE_ID —
// same show/hide checkbox, same drag-to-reorder, same save mechanism as any
// employee. Previously it was excluded here and driven purely by whether a
// live item was currently assigned to a supplier, with no way to override
// that default — the exact bug this fixes.

import { useState } from 'react';
import { GripVertical, SlidersHorizontal } from 'lucide-react';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Checkbox } from '@/components/ui/checkbox';
import { cn } from '@/lib/utils';
import { landingAboveIn } from '@/lib/dnd/landing';
import { SUPPLIERS_LANE_ID } from '@/lib/constants/workItems';

const ID_ATTR = 'data-board-emp-id';
const SUPPLIERS_ROW = { id: SUPPLIERS_LANE_ID, name: 'ספקים' };

interface Row {
  id: string;
  name: string;
  visible: boolean;
}

export function BoardOrderPopover({
  employees,
  visibleIds,
  onChange,
}: {
  /** The full employee roster in the viewer's scope — offered whether
   *  currently shown or not. The suppliers row is added automatically below,
   *  not part of this list. */
  employees: { id: string; name: string }[];
  /** The current effective lane order (default-computed or already
   *  customized) — may include SUPPLIERS_LANE_ID. */
  visibleIds: string[];
  /** Fires with the new visible set, in order, on every toggle or drop. May
   *  include SUPPLIERS_LANE_ID. */
  onChange: (next: string[]) => void;
}) {
  const [open, setOpen] = useState(false);
  const [rows, setRows] = useState<Row[]>([]);
  const [dragId, setDragId] = useState<string | null>(null);
  const [landing, setLanding] = useState<string | null>(null);

  function openPopover(o: boolean) {
    if (o) {
      const roster = [...employees, SUPPLIERS_ROW];
      const byId = new Map(roster.map((e) => [e.id, e.name]));
      const ordered = visibleIds.filter((id) => byId.has(id));
      const rest = roster.filter((e) => !ordered.includes(e.id));
      setRows([
        ...ordered.map((id) => ({ id, name: byId.get(id)!, visible: true })),
        ...rest.map((e) => ({ id: e.id, name: e.name, visible: false })),
      ]);
    } else {
      setDragId(null);
      setLanding(null);
    }
    setOpen(o);
  }

  function commit(next: Row[]) {
    setRows(next);
    onChange(next.filter((r) => r.visible).map((r) => r.id));
  }

  function toggle(id: string) {
    commit(rows.map((r) => (r.id === id ? { ...r, visible: !r.visible } : r)));
  }

  function drop(beforeId: string | null) {
    const id = dragId;
    setDragId(null);
    setLanding(null);
    if (!id) return;
    const from = rows.findIndex((r) => r.id === id);
    if (from === -1 || id === beforeId) return;
    const dragged = rows[from]!;
    const without = rows.filter((r) => r.id !== id);
    const toIdx = beforeId ? without.findIndex((r) => r.id === beforeId) : without.length;
    commit([...without.slice(0, toIdx), dragged, ...without.slice(toIdx)]);
  }

  return (
    <Popover open={open} onOpenChange={openPopover}>
      <PopoverTrigger className="inline-flex h-10 items-center gap-1.5 rounded-lg border border-line bg-white px-3 text-sm font-semibold text-ink-2 hover:bg-row-hover">
        <SlidersHorizontal className="h-4 w-4" />
        התאמת לוח
      </PopoverTrigger>
      <PopoverContent align="start" className="w-72 p-0">
        <div className="border-b border-line px-3 py-2 text-[12.5px] font-bold text-ink-3">
          מי מוצג בלוח, ובאיזה סדר
        </div>
        <div
          className="max-h-80 overflow-y-auto p-1"
          onDragOver={(e) => {
            if (!dragId) return;
            e.preventDefault();
            setLanding(landingAboveIn(e.currentTarget, e.clientY, dragId, ID_ATTR));
          }}
          onDrop={(e) => { e.preventDefault(); if (dragId) drop(landing); }}
        >
          {rows.map((r) => (
            <div
              key={r.id}
              data-board-emp-id={r.id}
              draggable
              onDragStart={(e) => {
                e.dataTransfer.setData('application/x-board-emp', r.id);
                e.dataTransfer.effectAllowed = 'move';
                setDragId(r.id);
              }}
              onDragEnd={() => { setDragId(null); setLanding(null); }}
              className={cn(
                'flex items-center gap-2 rounded-lg px-2 py-2 text-sm transition-colors',
                dragId === r.id && 'opacity-50',
                landing === r.id && 'ring-2 ring-brand/40',
              )}
            >
              <GripVertical className="h-4 w-4 shrink-0 cursor-grab text-ink-ghost active:cursor-grabbing" />
              <Checkbox checked={r.visible} onCheckedChange={() => toggle(r.id)} />
              <span className="min-w-0 flex-1 truncate text-ink-2">{r.name}</span>
            </div>
          ))}
        </div>
      </PopoverContent>
    </Popover>
  );
}
