'use client';

// Tasks kanban — twin of issues-kanban. The board's primary axis is PRIORITY:
// three lanes (דחוף / גבוהה / רגילה) plus a terminal "בוצע" drop-lane that
// completes the task (moving it to the completed tab — it leaves the board).
// Dragging between priority lanes re-prioritises and reorders (PATCH
// /api/tasks/reorder); dropping onto "בוצע" completes it (via onComplete).

import { useState } from 'react';
import { MessageSquare, Calendar } from 'lucide-react';
import { Trash2 } from 'lucide-react';
import { cn } from '@/lib/utils';
import { todayInJerusalem } from '@/lib/dates';
import { AssigneePills } from '@/components/assignee/AssigneePills';
import { TargetCell } from '@/components/targets/TargetCell';
import { RecurringBadge } from '@/components/recurrence/RecurringBadge';
import { CadenceStrip, CadenceProgress } from '@/components/recurrence/CadenceStrip';
import {
  TASK_KANBAN_COLUMNS, PRIORITY_BADGE, taskPriorityLabel,
} from '@/lib/constants/tasks';
import type { TaskPriority, TaskWithAssignee } from '@/lib/types/tasks';

interface Props {
  tasks: TaskWithAssignee[];
  canEdit: boolean;
  onSelect: (task: TaskWithAssignee) => void;
  /** Persist a priority lane's full top-to-bottom order after a drag — covers
   *  cross-lane moves (priority change) and within-lane manual reorder. */
  onReorder: (priority: TaskPriority, orderedIds: string[]) => void;
  /** Drop onto the terminal "בוצע" lane — completes the task (it leaves the board). */
  onComplete: (task: TaskWithAssignee) => void;
  /** When provided, a delete action is shown per card (RBAC-gated by the caller). */
  onDelete?: (task: TaskWithAssignee) => void;
}

function isOverdue(t: TaskWithAssignee): boolean {
  if (!t.due_date) return false;
  if (t.status === 'done' || t.status === 'cancelled') return false;
  // "today" anchored to Jerusalem (server runs UTC) so the overdue class matches
  // between SSR and hydration.
  return t.due_date < todayInJerusalem();
}

export function TasksKanban({ tasks, canEdit, onSelect, onReorder, onComplete, onDelete }: Props) {
  const [dragId, setDragId] = useState<string | null>(null);
  const [overCol, setOverCol] = useState<string | null>(null);
  const [overIndex, setOverIndex] = useState<number | null>(null);

  // Lanes group by priority; ordering within a lane is the manual drag order
  // (sort_order) then creation order. Completed tasks live in the "הושלמו" tab,
  // so the terminal "בוצע" lane is always an empty drop-target on this board.
  const byPriority = (p: TaskPriority) =>
    tasks
      .filter((t) => t.priority === p)
      .sort((a, b) => {
        if (a.sort_order !== b.sort_order) return a.sort_order - b.sort_order;
        return a.created_at.localeCompare(b.created_at);
      });

  // Build the destination lane's new id order with the dragged card inserted
  // before the card at `index` (null → append), then persist its priority.
  function dropInto(priority: TaskPriority, index: number | null) {
    if (!dragId) return;
    const items = byPriority(priority);
    const order = items.map((t) => t.id).filter((id) => id !== dragId);
    const targetId = index === null ? null : items[index]?.id;
    let pos = order.length;
    if (targetId && targetId !== dragId) {
      const idx = order.indexOf(targetId);
      if (idx !== -1) pos = idx;
    }
    order.splice(pos, 0, dragId);
    onReorder(priority, order);
    setDragId(null);
    setOverCol(null);
    setOverIndex(null);
  }

  // Drop onto "בוצע" → complete the dragged task via the [id] PATCH (onComplete);
  // it then leaves the active board for the completed tab.
  function completeDragged() {
    const task = dragId ? tasks.find((t) => t.id === dragId) : null;
    setDragId(null);
    setOverCol(null);
    setOverIndex(null);
    if (task) onComplete(task);
  }

  return (
    <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
      {TASK_KANBAN_COLUMNS.map((col) => {
        const items = col.kind === 'priority' ? byPriority(col.key) : [];
        // Closure narrows the column union: priority lanes reorder, "בוצע" completes.
        const laneDrop = (index: number | null) => {
          if (col.kind === 'done') completeDragged();
          else dropInto(col.key, index);
        };
        return (
          <div
            key={col.key}
            onDragOver={(e) => { if (canEdit && dragId) { e.preventDefault(); setOverCol(col.key); setOverIndex(null); } }}
            onDragLeave={() => setOverCol((c) => (c === col.key ? null : c))}
            onDrop={() => laneDrop(null)}
            className={cn(
              'flex min-h-[440px] flex-col rounded-2xl border bg-slate-100 p-3 transition-colors',
              overCol === col.key ? 'border-blue-300 bg-blue-50/60' : 'border-slate-200',
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
                <p className="py-9 text-center text-[13px] font-medium text-slate-400">
                  {col.kind === 'done' ? 'גררו לכאן לסימון כבוצע' : 'אין משימות'}
                </p>
              )}
              {items.map((t, idx) => (
                <div
                  key={t.id}
                  role="button"
                  tabIndex={0}
                  draggable={canEdit}
                  onDragStart={() => setDragId(t.id)}
                  onDragEnd={() => { setDragId(null); setOverCol(null); setOverIndex(null); }}
                  onDragOver={(e) => { if (canEdit && dragId && dragId !== t.id) { e.preventDefault(); e.stopPropagation(); setOverCol(col.key); setOverIndex(idx); } }}
                  onDrop={(e) => { e.stopPropagation(); laneDrop(idx); }}
                  onClick={() => onSelect(t)}
                  onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); onSelect(t); } }}
                  className={cn(
                    'group flex items-stretch overflow-hidden rounded-xl border border-slate-200 bg-white text-start shadow-[0_1px_2px_rgba(15,23,42,0.04)] transition-all hover:border-slate-300 hover:shadow-[0_10px_22px_-8px_rgba(15,23,42,0.18)]',
                    canEdit && 'cursor-grab active:cursor-grabbing',
                    dragId === t.id && 'opacity-50',
                    overCol === col.key && overIndex === idx && dragId !== t.id && 'ring-2 ring-blue-300',
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

                  <div className="flex min-w-0 flex-1 flex-col p-3.5">
                    <div className="flex items-start justify-between gap-2.5">
                      <h3 className="flex min-w-0 items-center gap-1.5 text-[15px] font-bold leading-snug text-slate-900">
                        <span className="line-clamp-2">{t.title}</span>
                        {t.recurrence && <RecurringBadge />}
                      </h3>
                      <div className="flex shrink-0 items-center gap-1">
                        {t.recurrence && (
                          <CadenceProgress
                            doneCount={t.recurrence.done_count}
                            expectedCount={t.recurrence.expected_count}
                            periodLabel={t.recurrence.period_label}
                          />
                        )}
                        {canEdit && onDelete && (
                          <button
                            type="button"
                            aria-label="מחק"
                            onClick={(e) => { e.stopPropagation(); onDelete(t); }}
                            className="grid h-7 w-7 place-items-center rounded-md text-slate-400 opacity-0 transition-opacity hover:bg-rose-50 hover:text-rose-600 group-hover:opacity-100"
                          >
                            <Trash2 className="h-3.5 w-3.5" />
                          </button>
                        )}
                        <span className={cn('inline-flex items-center rounded-md px-2 py-0.5 text-[11px] font-bold', PRIORITY_BADGE[t.priority])}>
                          {taskPriorityLabel(t.priority)}
                        </span>
                      </div>
                    </div>
                    {t.description && (
                      <p className="mt-1.5 line-clamp-2 text-[13px] leading-relaxed text-slate-500">{t.description}</p>
                    )}
                    <div className="mt-auto flex flex-col items-start gap-2 pt-3">
                      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-slate-400">
                        {t.target_type && t.target_label && (
                          <TargetCell type={t.target_type} label={t.target_label} size="sm" />
                        )}
                        {t.due_date && (
                          <span dir="ltr" className={cn('inline-flex items-center gap-1 tabular-nums', isOverdue(t) && 'font-bold text-rose-600')}>
                            <Calendar className="h-3 w-3" />{t.due_date}
                          </span>
                        )}
                        {t.comment_count > 0 && (
                          <span className="inline-flex items-center gap-0.5"><MessageSquare className="h-3 w-3" />{t.comment_count}</span>
                        )}
                      </div>
                      {t.assignees.length > 0 && (
                        <div className="flex flex-wrap items-center gap-1.5">
                          <AssigneePills assignees={t.assignees} size="sm" />
                        </div>
                      )}
                      {/* The whole cadence on the card itself — a recurring task
                          is ONE row (migration 067), so the days/months it repeats
                          on have to be legible without opening anything. */}
                      {t.recurrence && t.recurrence.chips.type !== 'none' && (
                        <div className="w-full border-t border-dashed border-slate-200 pt-2.5">
                          <CadenceStrip label={t.recurrence.label} chips={t.recurrence.chips} />
                        </div>
                      )}
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </div>
        );
      })}
    </div>
  );
}
