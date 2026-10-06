'use client';

// The reminders of one tab as a flat list the user can rearrange (06/10/2026).
// A mouse drags with native HTML5 drag and drop; a finger drags by LONG PRESS
// (useLongPressDrag — ~500ms, a small tolerance; a touch that moves sooner is
// a scroll, a short one a tap), exactly like the issues kanban: the card lifts
// and follows the finger, the list scrolls itself near its edges. The drop
// lands the card where it was released — directly above the card under the
// pointer (that card gets the ring), or at the bottom (a bar under the last
// card). A drop where the card already is changes nothing. A click opens the
// reminder; a drag is never a click.
//
// Whose order it is and what to store is the page's business (onDrop): this
// list only reports which card landed above which.

import { useRef, useState } from 'react';
import { cn } from '@/lib/utils';
import { useLongPressDrag, type DragPoint } from '@/lib/hooks/useLongPressDrag';
import { inside, landingAboveIn, scrollParent } from '@/lib/dnd/landing';
import type { UserReminderWithNames } from '@/lib/types/userReminders';
import { ReminderCard } from './ReminderCard';

/** The cards carry their id here — the e2e and the drop arithmetic read it. */
const ID_ATTR = 'data-reminder-id';

interface Props {
  /** The cards to show, in order. */
  items: UserReminderWithNames[];
  /** user_reminders:edit — the card's "סמן כהושלם". */
  canEdit: boolean;
  /** The tab's order is the user's to drag (שלי / משותף איתי). */
  canReorder: boolean;
  canDelete: (r: UserReminderWithNames) => boolean;
  overdue: (r: UserReminderWithNames) => boolean;
  onOpen: (r: UserReminderWithNames) => void;
  onComplete: (r: UserReminderWithNames) => void;
  onDelete: (r: UserReminderWithNames) => void;
  /** `dragId` was dropped directly above `beforeId` (null = below the last
   *  card shown). Never called for "no change". */
  onDrop: (dragId: string, beforeId: string | null) => void;
}

/** Where a drop would land: the card it would sit above (null = the bottom). */
interface Landing {
  beforeId: string | null;
}

/** A card carried by a finger: where it started, and what scrolls under it. */
interface Carried {
  id: string;
  el: HTMLElement;
  start: DragPoint;
  last: DragPoint;
  scroller: HTMLElement;
  scrollTop0: number;
  raf: number;
}

export function ReminderList({
  items, canEdit, canReorder, canDelete, overdue, onOpen, onComplete, onDelete, onDrop,
}: Props) {
  const [dragId, setDragId] = useState<string | null>(null);
  const [landing, setLanding] = useState<Landing | null>(null);
  // Set when a drag starts, cleared by the next press — a drag is never a click.
  const dragged = useRef(false);
  const listRef = useRef<HTMLDivElement>(null);
  // Touch: the carried card (moved by style.transform, no re-render per move)
  // and its id for the "lifted" look.
  const carried = useRef<Carried | null>(null);
  const [touchId, setTouchId] = useState<string | null>(null);

  function endDrag() {
    setDragId(null);
    setLanding(null);
  }

  /** The dragged card dropped back where it already is. */
  function samePlace(beforeId: string | null): boolean {
    const at = items.findIndex((r) => r.id === dragId);
    return at !== -1 && (items[at + 1]?.id ?? null) === beforeId;
  }

  function drop(beforeId: string | null) {
    const id = dragId;
    const unchanged = samePlace(beforeId);
    endDrag();
    if (id && !unchanged) onDrop(id, beforeId);
  }

  /** Where a finger at `p` would drop the carried card; null = off the list. */
  function touchLanding(p: DragPoint): Landing | null {
    const c = carried.current;
    const list = listRef.current;
    if (!c || !list || !inside(list.getBoundingClientRect(), p)) return null;
    return { beforeId: landingAboveIn(list, p.y, c.id, ID_ATTR) };
  }

  /** The carried card follows the finger (vertically), the scroll under it
   *  included, and the landing marker follows too. */
  function follow(p: DragPoint) {
    const c = carried.current;
    if (!c) return;
    c.last = p;
    const dy = p.y - c.start.y + (c.scroller.scrollTop - c.scrollTop0);
    c.el.style.transform = `translateY(${dy}px)`;
    const spot = touchLanding(p);
    if (spot === null) return;
    setLanding((l) => (l?.beforeId === spot.beforeId ? l : spot));
  }

  /** Near the top / bottom edge of the scroller, scroll toward it. */
  function autoScroll() {
    const c = carried.current;
    if (!c) return;
    const r = c.scroller.getBoundingClientRect();
    const top = Math.max(r.top, 0) + 64;
    const bottom = Math.min(r.bottom, window.innerHeight) - 64;
    const step = c.last.y < top ? -Math.min(16, Math.ceil((top - c.last.y) / 4))
      : c.last.y > bottom ? Math.min(16, Math.ceil((c.last.y - bottom) / 4)) : 0;
    if (step !== 0) {
      c.scroller.scrollTop += step;
      follow(c.last);
    }
    c.raf = requestAnimationFrame(autoScroll);
  }

  function release() {
    const c = carried.current;
    if (!c) return;
    cancelAnimationFrame(c.raf);
    c.el.style.transform = '';
    carried.current = null;
    setTouchId(null);
  }

  const longPress = useLongPressDrag({
    onStart: (id, p) => {
      const list = listRef.current;
      const el = list?.querySelector<HTMLElement>(`[${ID_ATTR}="${id}"]`);
      if (!list || !el) return;
      const scroller = scrollParent(list);
      carried.current = { id, el, start: p, last: p, scroller, scrollTop0: scroller.scrollTop, raf: 0 };
      dragged.current = true;
      setDragId(id);
      setTouchId(id);
      follow(p);
      carried.current.raf = requestAnimationFrame(autoScroll);
    },
    onMove: follow,
    onDrop: (p) => {
      const spot = touchLanding(p);
      release();
      if (spot) drop(spot.beforeId);
      else endDrag();
    },
    onCancel: () => {
      release();
      endDrag();
    },
  }, { enabled: canReorder });

  const here = landing && !samePlace(landing.beforeId) ? landing : null;

  return (
    <div
      ref={listRef}
      className="space-y-2"
      onDragOver={(e) => {
        if (!canReorder || !dragId) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = 'move';
        const beforeId = landingAboveIn(e.currentTarget, e.clientY, dragId, ID_ATTR);
        setLanding((l) => (l?.beforeId === beforeId ? l : { beforeId }));
      }}
      onDragLeave={(e) => {
        if (e.currentTarget.contains(e.relatedTarget as Node | null)) return;
        setLanding(null);
      }}
      onDrop={(e) => {
        e.preventDefault();
        if (canReorder && dragId) drop(landingAboveIn(e.currentTarget, e.clientY, dragId, ID_ATTR));
      }}
    >
      {items.map((r) => (
        <div
          key={r.id}
          data-reminder-id={r.id}
          draggable={canReorder && !longPress.holding}
          onPointerDown={() => { dragged.current = false; }}
          onTouchStart={(e) => longPress.onTouchStart(r.id, e)}
          onContextMenu={(e) => { if (longPress.holding) e.preventDefault(); }}
          onDragStart={(e) => {
            // A custom type, so a stray drop into a text field types nothing.
            e.dataTransfer.setData('application/x-reminder-id', r.id);
            e.dataTransfer.effectAllowed = 'move';
            dragged.current = true;
            setDragId(r.id);
          }}
          onDragEnd={endDrag}
          onClickCapture={(e) => {
            if (!dragged.current) return;
            e.preventDefault();
            e.stopPropagation();
          }}
          className={cn(
            'rounded-lg transition-shadow',
            canReorder && 'cursor-grab select-none active:cursor-grabbing [-webkit-touch-callout:none]',
            dragId === r.id && touchId !== r.id && 'opacity-50',
            // Lifted under a finger: above the rest, the hover shadow, no lag.
            touchId === r.id && 'relative z-30 scale-[1.02] shadow-[0_10px_22px_-8px_rgba(15,23,42,0.18)] transition-none',
            here?.beforeId === r.id && 'ring-2 ring-blue-300',
          )}
        >
          <ReminderCard
            reminder={r}
            canEdit={canEdit}
            canDelete={canDelete(r)}
            grip={canReorder}
            overdue={overdue(r)}
            onOpen={() => onOpen(r)}
            onComplete={() => onComplete(r)}
            onDelete={() => onDelete(r)}
          />
        </div>
      ))}
      {here && here.beforeId === null && items.some((r) => r.id !== dragId) && (
        <div aria-hidden className="h-1 rounded-full bg-blue-300" />
      )}
    </div>
  );
}
