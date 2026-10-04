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

import { useMemo, useRef, useState, type DragEvent } from 'react';
import { CalendarDays, ImageIcon, MessageSquare, Trash2 } from 'lucide-react';
import { cn } from '@/lib/utils';
import { AssigneePills } from '@/components/assignee/AssigneePills';
import { TargetCell } from '@/components/targets/TargetCell';
import { ISSUE_PRIORITY_BADGE, issuePriorityLabel } from '@/lib/constants/issues';
import {
  ISSUE_BOARD_COLUMNS, groupBoard, overdueDays, overdueLabel, type IssueBoardColumnKey,
} from '@/lib/issues/board';
import type { IssueBoardColumn, IssueWithMeta } from '@/lib/types/issues';
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

  const board = useMemo(() => groupBoard(issues, today), [issues, today]);

  function endDrag() {
    setDragId(null);
    setLanding(null);
  }

  /** The card a drop at the pointer lands above: the first card (other than
   *  the dragged one) whose middle is below the pointer; none = the bottom. */
  function landingAbove(e: DragEvent<HTMLDivElement>): string | null {
    for (const el of e.currentTarget.querySelectorAll<HTMLElement>('[data-issue-id]')) {
      if (el.dataset.issueId === dragId) continue;
      const r = el.getBoundingClientRect();
      if (e.clientY < r.top + r.height / 2) return el.dataset.issueId ?? null;
    }
    return null;
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
    <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
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
              const beforeId = col.key === 'done' ? null : landingAbove(e);
              setLanding((l) => (l?.column === col.key && l.beforeId === beforeId ? l : { column: col.key, beforeId }));
            }}
            onDragLeave={(e) => {
              if (e.currentTarget.contains(e.relatedTarget as Node | null)) return;
              setLanding((l) => (l?.column === col.key ? null : l));
            }}
            onDrop={(e) => {
              e.preventDefault();
              if (canEdit && dragId) drop(col.key, col.key === 'done' ? null : landingAbove(e));
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
                    draggable={canEdit}
                    onPointerDown={() => { dragged.current = false; }}
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
                      canEdit && 'cursor-grab active:cursor-grabbing',
                      dragId === i.id && 'opacity-50',
                      here?.beforeId === i.id && 'ring-2 ring-blue-300',
                    )}
                  >
                    {/* Drag grip — visual affordance only; the whole card stays draggable. */}
                    <div
                      className="flex w-[26px] flex-none items-center justify-center border-l border-slate-100 bg-slate-50 transition-colors group-hover:bg-slate-100"
                      aria-hidden
                    >
                      <span className="grid grid-cols-2 gap-[3px]">
                        {Array.from({ length: 6 }).map((_, d) => (
                          <span key={d} className="h-1 w-1 rounded-full bg-slate-300 transition-colors group-hover:bg-slate-400" />
                        ))}
                      </span>
                    </div>

                    <div className="flex min-w-0 flex-1 flex-col">
                      {resident && <ResidentReportStrip issue={i} variant="card" />}
                      <div className="flex min-w-0 flex-1 flex-col p-3.5">
                        <div className="flex items-start justify-between gap-2.5">
                          <h3 className="min-w-0 text-[15px] font-bold leading-snug text-slate-900">
                            <span className="line-clamp-2">{i.title}</span>
                          </h3>
                          <div className="flex shrink-0 items-center gap-1">
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
