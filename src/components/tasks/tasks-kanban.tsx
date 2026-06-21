'use client';

import { useState } from 'react';
import { MessageSquare, Calendar, Pencil, Trash2 } from 'lucide-react';
import { cn } from '@/lib/utils';
import { AssigneePills } from '@/components/assignee/AssigneePills';
import { TargetCell } from '@/components/targets/TargetCell';
import { RecurringBadge } from '@/components/recurrence/RecurringBadge';
import {
  TASK_STATUSES, STATUS_DOT, PRIORITY_BADGE, taskPriorityLabel,
} from '@/lib/constants/tasks';
import type { TaskStatus, TaskWithAssignee } from '@/lib/types/tasks';

interface Props {
  tasks: TaskWithAssignee[];
  canEdit: boolean;
  onSelect: (task: TaskWithAssignee) => void;
  /** Persist a destination column's full top-to-bottom order after a drag — this
   *  covers BOTH cross-column moves (status change) and within-column manual
   *  reorder. `orderedIds` is the column's new card order; the caller renumbers
   *  sort_order = position and sets status for every id. */
  onReorder: (status: TaskStatus, orderedIds: string[]) => void;
  /** Which status columns to render. Defaults to all. The "פעילות" tab passes the
   *  active statuses so completed tasks don't appear on the board. */
  statuses?: TaskStatus[];
  /** When provided, a delete action is shown per card (RBAC-gated by the caller). */
  onDelete?: (task: TaskWithAssignee) => void;
}

function isOverdue(t: TaskWithAssignee): boolean {
  if (!t.due_date) return false;
  if (t.status === 'done' || t.status === 'cancelled') return false;
  return t.due_date < new Date().toISOString().slice(0, 10);
}

export function TasksKanban({ tasks, canEdit, onSelect, onReorder, statuses, onDelete }: Props) {
  const [dragId, setDragId] = useState<string | null>(null);
  const [overCol, setOverCol] = useState<TaskStatus | null>(null);
  const [overIndex, setOverIndex] = useState<number | null>(null);

  const columns = statuses
    ? TASK_STATUSES.filter((c) => statuses.includes(c.value))
    : TASK_STATUSES;

  // Ordering: urgent first (pinned on top), then the manual drag order
  // (sort_order), then created_at as a stable tiebreaker. Due-date sorting lives
  // in the table view; the board is manually orderable per the reorder spec.
  const byStatus = (s: TaskStatus) =>
    tasks
      .filter((t) => t.status === s)
      .sort((a, b) => {
        const au = a.priority === 'urgent' ? 0 : 1;
        const bu = b.priority === 'urgent' ? 0 : 1;
        if (au !== bu) return au - bu;
        if (a.sort_order !== b.sort_order) return a.sort_order - b.sort_order;
        return a.created_at.localeCompare(b.created_at);
      });

  // Build the destination column's new id order with the dragged card inserted
  // before the card at `index` (null → append to the end), then persist.
  function dropInto(status: TaskStatus, index: number | null) {
    if (!dragId) return;
    const items = byStatus(status);
    const order = items.map((t) => t.id).filter((id) => id !== dragId);
    const targetId = index === null ? null : items[index]?.id;
    let pos = order.length;
    if (targetId && targetId !== dragId) {
      const idx = order.indexOf(targetId);
      if (idx !== -1) pos = idx;
    }
    order.splice(pos, 0, dragId);
    onReorder(status, order);
    setDragId(null);
    setOverCol(null);
    setOverIndex(null);
  }

  return (
    <div className={cn('grid grid-cols-1 gap-4 sm:grid-cols-2', columns.length <= 2 ? 'lg:grid-cols-2' : 'lg:grid-cols-4')}>
      {columns.map((col) => {
        const items = byStatus(col.value);
        return (
          <div
            key={col.value}
            onDragOver={(e) => { if (canEdit && dragId) { e.preventDefault(); setOverCol(col.value); setOverIndex(null); } }}
            onDragLeave={() => setOverCol((c) => (c === col.value ? null : c))}
            onDrop={() => dropInto(col.value, null)}
            className={cn(
              'flex flex-col rounded-xl border bg-slate-50/60 transition-colors',
              overCol === col.value ? 'border-blue-300 bg-blue-50/50' : 'border-slate-200',
            )}
          >
            <div className="flex items-center justify-between gap-2 border-b border-slate-200 px-4 py-3">
              <div className="flex items-center gap-2">
                <span className={cn('h-2 w-2 rounded-full', STATUS_DOT[col.value])} />
                <h3 className="text-sm font-bold text-slate-700">{col.label}</h3>
              </div>
              <span className="inline-flex items-center justify-center rounded-full bg-white px-2 py-0.5 text-xs font-bold text-slate-500 ring-1 ring-slate-200">
                {items.length}
              </span>
            </div>

            <div className="flex flex-1 flex-col gap-2 p-3">
              {items.length === 0 && (
                <p className="py-6 text-center text-xs text-slate-400">אין משימות</p>
              )}
              {items.map((t, idx) => (
                <div
                  key={t.id}
                  role="button"
                  tabIndex={0}
                  draggable={canEdit}
                  onDragStart={() => setDragId(t.id)}
                  onDragEnd={() => { setDragId(null); setOverCol(null); setOverIndex(null); }}
                  onDragOver={(e) => { if (canEdit && dragId && dragId !== t.id) { e.preventDefault(); e.stopPropagation(); setOverCol(col.value); setOverIndex(idx); } }}
                  onDrop={(e) => { e.stopPropagation(); dropInto(col.value, idx); }}
                  onClick={() => onSelect(t)}
                  onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); onSelect(t); } }}
                  className={cn(
                    'group w-full rounded-lg border border-slate-200 bg-white p-3 text-start shadow-[0_1px_2px_rgba(15,23,42,0.04)] transition-shadow hover:shadow-md',
                    canEdit && 'cursor-grab active:cursor-grabbing',
                    dragId === t.id && 'opacity-50',
                    overCol === col.value && overIndex === idx && dragId !== t.id && 'ring-2 ring-blue-300',
                  )}
                >
                  <div className="flex items-start justify-between gap-2">
                    <span className="flex min-w-0 items-center gap-1.5 text-sm font-semibold text-slate-900">
                      <span className="truncate">{t.title}</span>
                      {(t.is_recurring_template || t.is_recurring_instance) && <RecurringBadge />}
                    </span>
                    <div className="flex shrink-0 items-center gap-1">
                      {canEdit && (
                        <div className="flex items-center gap-0.5 opacity-0 transition-opacity group-hover:opacity-100">
                          <button
                            type="button"
                            aria-label="ערוך"
                            onClick={(e) => { e.stopPropagation(); onSelect(t); }}
                            className="grid h-7 w-7 place-items-center rounded-md text-slate-400 hover:bg-slate-100 hover:text-slate-700"
                          >
                            <Pencil className="h-3.5 w-3.5" />
                          </button>
                          {onDelete && (
                            <button
                              type="button"
                              aria-label="מחק"
                              onClick={(e) => { e.stopPropagation(); onDelete(t); }}
                              className="grid h-7 w-7 place-items-center rounded-md text-slate-400 hover:bg-rose-50 hover:text-rose-600"
                            >
                              <Trash2 className="h-3.5 w-3.5" />
                            </button>
                          )}
                        </div>
                      )}
                      <span className={cn('inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-medium', PRIORITY_BADGE[t.priority])}>
                        {taskPriorityLabel(t.priority)}
                      </span>
                    </div>
                  </div>
                  {t.description && (
                    <p className="mt-1 line-clamp-2 text-xs text-slate-500">{t.description}</p>
                  )}
                  <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-slate-400">
                    {t.assignees.length > 0 && <AssigneePills assignees={t.assignees} size="sm" />}
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
                </div>
              ))}
            </div>
          </div>
        );
      })}
    </div>
  );
}
