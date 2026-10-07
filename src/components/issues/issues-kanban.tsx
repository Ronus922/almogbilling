'use client';

// Issues kanban — by STAGE OF HANDLING (phase C, 03/10/2026), a MANUAL board
// since 04/10/2026 (lib/issues/board.ts). Four columns, right to left: ממתין
// לשיוך · לטיפול היום · בטיפול · בוצע. A card starts in the column the stage
// rule gives it and from then on moves only when it is dragged.
//
// Dragging places the card exactly where it is dropped — in its own column or
// another one, at that position — and the page stores it (onMove). A drop
// changes nothing else and opens nothing; "בוצע" alone closes the issue
// (onComplete). While dragging, the card the drop will land above gets the
// ring (the same ring-2 ring-blue-300 as the tasks board); landing at the
// bottom shows a bar under the last card. A click opens the issue; a drag is
// never a click.
//
// Touch (04/10/2026): a mouse drags with native HTML5 drag and drop, which a
// phone or tablet does not deliver, so a finger drags by LONG PRESS
// (useLongPressDrag — ~500ms, a small tolerance; a touch that moves sooner is
// a scroll, a short one a tap). The card lifts and follows the finger, the
// same landing marker shows, and the drop goes through the same onMove /
// onComplete. From 768px up the drag crosses columns; on a phone it reorders
// inside the card's own column only, and "העבר אל…" (IssueMoveToMenu) moves
// it to the top of another one.

import { useMemo, useRef, useState } from 'react';
import { CalendarDays, ImageIcon, MessageSquare, Trash2 } from 'lucide-react';
import { cn } from '@/lib/utils';
import { AssigneePills } from '@/components/assignee/AssigneePills';
import { TargetCell } from '@/components/targets/TargetCell';
import { ISSUE_PRIORITY_BADGE, issuePriorityLabel } from '@/lib/constants/issues';
import {
  ISSUE_BOARD_COLUMNS, groupBoard, moveToAction, moveToTargets, overdueDays, overdueLabel,
  type IssueBoardColumnKey,
} from '@/lib/issues/board';
import { useLongPressDrag, type DragPoint } from '@/lib/hooks/useLongPressDrag';
import { inside, landingAboveIn, scrollParent } from '@/lib/dnd/landing';
import { DragGrip } from '@/components/dnd/DragGrip';
import { CreatedByLine } from '@/components/shared/CreatedByLine';
import type { IssueBoardColumn, IssueWithMeta } from '@/lib/types/issues';
import { IssueMoveToMenu } from './IssueMoveToMenu';
import { RESIDENT_REPORT_ACCENT, ResidentReportStrip } from './IssueReporter';

interface Props {
  issues: IssueWithMeta[];
  /** 'YYYY-MM-DD' on the Asia/Jerusalem calendar (useJerusalemToday). */
  today: string;
  canEdit: boolean;
  onSelect: (issue: IssueWithMeta) => void;
  /** A card was dropped into `column`, directly above `beforeId` (null = at
   *  the bottom) — its own column included. Never called for "no change". */
  onMove: (issue: IssueWithMeta, column: IssueBoardColumn, beforeId: string | null) => void;
  /** A card was dropped on "בוצע" — the page closes the issue. */
  onComplete: (issue: IssueWithMeta) => void;
  /** When provided, a delete action is shown per card (RBAC-gated by the caller). */
  onDelete?: (issue: IssueWithMeta) => void;
}

/** Where a drop would land: the column, and the card it would sit above. */
interface Landing {
  column: IssueBoardColumnKey;
  beforeId: string | null;
}

/** From here up a touch drag crosses columns; below it ("phone") it only
 *  reorders inside the card's column — the same 768px as Tailwind's md. */
const CROSS_COLUMN_TOUCH = '(min-width: 768px)';

/** A card carried by a finger: where it came from, and what scrolls under it. */
interface Carried {
  id: string;
  from: IssueBoardColumnKey;
  el: HTMLElement;
  start: DragPoint;
  last: DragPoint;
  scroller: HTMLElement;
  scrollTop0: number;
  across: boolean;
  raf: number;
}

/** The cards of the board carry their id here (lib/dnd/landing.ts). */
const ID_ATTR = 'data-issue-id';

/** '2026-10-05' (+ '14:00') → '05/10 · 14:00'. */
function dueChipText(date: string, time: string | null): string {
  const [, m, d] = date.split('-');
  return time ? `${d}/${m} · ${time.slice(0, 5)}` : `${d}/${m}`;
}

export function IssuesKanban({ issues, today, canEdit, onSelect, onMove, onComplete, onDelete }: Props) {
  const [dragId, setDragId] = useState<string | null>(null);
  const [landing, setLanding] = useState<Landing | null>(null);
  // Set when a drag starts, cleared by the next press — a drag is never a click.
  const dragged = useRef(false);
  const gridRef = useRef<HTMLDivElement>(null);
  // Touch: the carried card (moved by style.transform, no re-render per move)
  // and its id for the "lifted" look.
  const carried = useRef<Carried | null>(null);
  const [touchId, setTouchId] = useState<string | null>(null);

  const board = useMemo(() => groupBoard(issues, today), [issues, today]);

  function endDrag() {
    setDragId(null);
    setLanding(null);
  }

  /** Where a finger at `p` would drop the carried card; undefined = in a gap
   *  between columns (keep the last spot), null = off the board. */
  function touchLanding(p: DragPoint): Landing | null | undefined {
    const c = carried.current;
    const grid = gridRef.current;
    if (!c || !grid) return null;
    const column = c.across
      ? Array.from(grid.querySelectorAll<HTMLElement>('[data-column]')).find((el) => inside(el.getBoundingClientRect(), p))
      : grid.querySelector<HTMLElement>(`[data-column="${c.from}"]`);
    if (!column) return inside(grid.getBoundingClientRect(), p) ? undefined : null;
    const key = column.dataset.column as IssueBoardColumnKey;
    return { column: key, beforeId: key === 'done' ? null : landingAboveIn(column, p.y, c.id, ID_ATTR) };
  }

  /** The carried card follows the finger (vertically only on a phone), the
   *  scroll under it included, and the landing marker follows too. */
  function follow(p: DragPoint) {
    const c = carried.current;
    if (!c) return;
    c.last = p;
    const dx = c.across ? p.x - c.start.x : 0;
    const dy = p.y - c.start.y + (c.scroller.scrollTop - c.scrollTop0);
    c.el.style.transform = `translate(${dx}px, ${dy}px)`;
    const spot = touchLanding(p);
    if (spot === undefined) return;
    setLanding((l) => (l?.column === spot?.column && l?.beforeId === spot?.beforeId ? l : spot));
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
      const grid = gridRef.current;
      const el = grid?.querySelector<HTMLElement>(`[data-issue-id="${id}"]`);
      const from = el?.closest<HTMLElement>('[data-column]')?.dataset.column as IssueBoardColumnKey | undefined;
      if (!grid || !el || !from) return;
      const scroller = scrollParent(grid);
      carried.current = {
        id, from, el, start: p, last: p, scroller, scrollTop0: scroller.scrollTop,
        across: window.matchMedia(CROSS_COLUMN_TOUCH).matches, raf: 0,
      };
      dragged.current = true;
      setDragId(id);
      setTouchId(id);
      follow(p);
      carried.current.raf = requestAnimationFrame(autoScroll);
    },
    onMove: follow,
    onDrop: (p) => {
      const spot = touchLanding(p);
      const target = spot === undefined ? landing : spot;
      release();
      if (target) drop(target.column, target.beforeId);
      else endDrag();
    },
    onCancel: () => {
      release();
      endDrag();
    },
  }, { enabled: canEdit });

  /** "העבר אל…": the top of the chosen column, or "בוצע" = close. */
  function moveTo(issue: IssueWithMeta, target: IssueBoardColumnKey) {
    const action = moveToAction(issues, issue.id, target, today);
    if (action.kind === 'complete') onComplete(issue);
    else onMove(issue, action.column, action.beforeId);
  }

  /** The dragged card dropped back where it already is. */
  function samePlace(column: IssueBoardColumnKey, beforeId: string | null): boolean {
    const list = board[column];
    const at = list.findIndex((i) => i.id === dragId);
    return at !== -1 && (list[at + 1]?.id ?? null) === beforeId;
  }

  function drop(column: IssueBoardColumnKey, beforeId: string | null) {
    const issue = dragId ? issues.find((i) => i.id === dragId) : undefined;
    const unchanged = samePlace(column, beforeId);
    endDrag();
    if (!issue) return;
    if (column === 'done') onComplete(issue);
    else if (!unchanged) onMove(issue, column, beforeId);
  }

  return (
    <div ref={gridRef} className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
      {ISSUE_BOARD_COLUMNS.map((col) => {
        const items = board[col.key];
        const here = landing?.column === col.key && !samePlace(col.key, landing.beforeId) ? landing : null;
        return (
          <div
            key={col.key}
            data-column={col.key}
            onDragOver={(e) => {
              if (!canEdit || !dragId) return;
              e.preventDefault();
              e.dataTransfer.dropEffect = 'move';
              const beforeId = col.key === 'done' ? null : landingAboveIn(e.currentTarget, e.clientY, dragId, ID_ATTR);
              setLanding((l) => (l?.column === col.key && l.beforeId === beforeId ? l : { column: col.key, beforeId }));
            }}
            onDragLeave={(e) => {
              if (e.currentTarget.contains(e.relatedTarget as Node | null)) return;
              setLanding((l) => (l?.column === col.key ? null : l));
            }}
            onDrop={(e) => {
              e.preventDefault();
              if (canEdit && dragId) drop(col.key, col.key === 'done' ? null : landingAboveIn(e.currentTarget, e.clientY, dragId, ID_ATTR));
            }}
            className={cn(
              'flex min-h-[440px] flex-col rounded-2xl border bg-slate-100 p-3 transition-colors',
              landing?.column === col.key ? 'border-blue-300 bg-blue-50/60' : 'border-slate-200',
            )}
          >
            <div className="flex items-center justify-between gap-2 px-2 pb-3 pt-1">
              <div className="flex items-center gap-2">
                <span className={cn('h-2.5 w-2.5 rounded-full', col.dot)} />
                <h3 className="text-[15px] font-bold text-slate-700">{col.label}</h3>
              </div>
              <span className="inline-flex h-6 min-w-6 items-center justify-center rounded-lg bg-white px-2 text-[13px] font-bold text-slate-500">
                {items.length}
              </span>
            </div>

            <div className="flex flex-1 flex-col gap-2.5">
              {items.length === 0 && (
                <p className="py-9 text-center text-[13px] font-medium text-slate-400">{col.empty}</p>
              )}
              {items.map((i) => {
                const late = col.key === 'today' ? overdueDays(i, today) : 0;
                const resident = i.source === 'portal';
                return (
                  <div
                    key={i.id}
                    role="button"
                    tabIndex={0}
                    data-issue-id={i.id}
                    draggable={canEdit && !longPress.holding}
                    onPointerDown={() => { dragged.current = false; }}
                    onTouchStart={(e) => longPress.onTouchStart(i.id, e)}
                    onContextMenu={(e) => { if (longPress.holding) e.preventDefault(); }}
                    onDragStart={(e) => {
                      // A custom type, so a stray drop into a text field types nothing.
                      e.dataTransfer.setData('application/x-issue-id', i.id);
                      e.dataTransfer.effectAllowed = 'move';
                      dragged.current = true;
                      setDragId(i.id);
                    }}
                    onDragEnd={endDrag}
                    onClick={() => { if (!dragged.current) onSelect(i); }}
                    onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); onSelect(i); } }}
                    className={cn(
                      'group flex items-stretch overflow-hidden rounded-xl border border-slate-200 bg-white text-start shadow-[0_1px_2px_rgba(15,23,42,0.04)] transition-all hover:border-slate-300 hover:shadow-[0_10px_22px_-8px_rgba(15,23,42,0.18)]',
                      resident && cn(RESIDENT_REPORT_ACCENT, 'hover:border-s-violet-500'),
                      canEdit && 'cursor-grab select-none active:cursor-grabbing [-webkit-touch-callout:none]',
                      dragId === i.id && touchId !== i.id && 'opacity-50',
                      // Lifted under a finger: above the other columns, the hover shadow, no lag.
                      touchId === i.id && 'relative z-30 scale-[1.02] shadow-[0_10px_22px_-8px_rgba(15,23,42,0.18)] transition-none',
                      here?.beforeId === i.id && 'ring-2 ring-blue-300',
                    )}
                  >
                    <DragGrip />

                    <div className="flex min-w-0 flex-1 flex-col">
                      {resident && <ResidentReportStrip issue={i} variant="card" />}
                      <div className="flex min-w-0 flex-1 flex-col p-3.5">
                        <div className="flex items-start justify-between gap-2.5">
                          <h3 className="min-w-0 text-[15px] font-bold leading-snug text-slate-900">
                            <span className="line-clamp-2">{i.title}</span>
                          </h3>
                          <div className="flex shrink-0 items-center gap-1">
                            {canEdit && (
                              <IssueMoveToMenu targets={moveToTargets(i, today)} onChoose={(c) => moveTo(i, c)} />
                            )}
                            {canEdit && onDelete && (
                              <button
                                type="button"
                                aria-label="מחק"
                                onClick={(e) => { e.stopPropagation(); onDelete(i); }}
                                className="grid h-7 w-7 place-items-center rounded-md text-slate-400 opacity-0 transition-opacity hover:bg-rose-50 hover:text-rose-600 group-hover:opacity-100"
                              >
                                <Trash2 className="h-3.5 w-3.5" />
                              </button>
                            )}
                            <span className={cn('inline-flex items-center rounded-md px-2 py-0.5 text-[11px] font-bold', ISSUE_PRIORITY_BADGE[i.priority])}>
                              {issuePriorityLabel(i.priority)}
                            </span>
                          </div>
                        </div>
                        {(late > 0 || (i.due_date && col.key !== 'done')) && (
                          <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
                            {late > 0 ? (
                              <span className="inline-flex items-center rounded-md bg-rose-100 px-2 py-0.5 text-[11px] font-bold text-rose-700">
                                {overdueLabel(late)}
                              </span>
                            ) : i.due_date ? (
                              <span className="inline-flex items-center gap-1 rounded-md bg-blue-50 px-2 py-0.5 text-[11px] font-semibold text-blue-700">
                                <CalendarDays className="h-3 w-3" aria-hidden />
                                <span dir="ltr" className="tabular-nums">{dueChipText(i.due_date, i.due_time)}</span>
                              </span>
                            ) : null}
                          </div>
                        )}
                        {i.description && (
                          <p className="mt-1.5 line-clamp-2 text-[13px] leading-relaxed text-slate-500">{i.description}</p>
                        )}
                        <div className="mt-auto flex flex-col items-start gap-2 pt-3">
                          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-slate-400">
                            {i.target_type && i.target_label && (
                              <TargetCell type={i.target_type} label={i.target_label} size="sm" />
                            )}
                            {i.images.length > 0 && (
                              <span className="inline-flex items-center gap-0.5"><ImageIcon className="h-3 w-3" />{i.images.length}</span>
                            )}
                            {i.comment_count > 0 && (
                              <span className="inline-flex items-center gap-0.5"><MessageSquare className="h-3 w-3" />{i.comment_count}</span>
                            )}
                          </div>
                          {i.assignees.length > 0 && (
                            <div className="flex flex-wrap items-center gap-1.5">
                              <AssigneePills assignees={i.assignees} size="sm" />
                            </div>
                          )}
                          {/* Who opened it and when (Asia/Jerusalem). */}
                          <CreatedByLine name={i.created_by_name} createdAt={i.created_at} className="self-stretch" />
                        </div>
                      </div>
                    </div>
                  </div>
                );
              })}
              {here && here.beforeId === null && col.key !== 'done' && items.some((i) => i.id !== dragId) && (
                <div aria-hidden className="h-1 rounded-full bg-blue-300" />
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}
