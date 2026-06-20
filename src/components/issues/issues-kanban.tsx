'use client';

// Issues kanban — twin of tasks-kanban (same drag state machine, column grid, card
// chrome and within-column reorder). Differences: issues have no due_date, so there
// is no overdue/date chip. Cross-column drag changes status and within-column drag
// reorders; both persist via the column's onReorder (PATCH /api/issues/reorder).

import { useState } from 'react';
import { MessageSquare, ImageIcon, Pencil, Trash2 } from 'lucide-react';
import { cn } from '@/lib/utils';
import { AssigneePills } from '@/components/assignee/AssigneePills';
import { TargetCell } from '@/components/targets/TargetCell';
import {
  ISSUE_STATUSES, ISSUE_STATUS_DOT, ISSUE_PRIORITY_BADGE, issuePriorityLabel,
} from '@/lib/constants/issues';
import type { IssueStatus, IssueWithMeta } from '@/lib/types/issues';

interface Props {
  issues: IssueWithMeta[];
  canEdit: boolean;
  onSelect: (issue: IssueWithMeta) => void;
  /** Persist a destination column's full top-to-bottom order after a drag — covers
   *  cross-column moves (status change) and within-column manual reorder. */
  onReorder: (status: IssueStatus, orderedIds: string[]) => void;
  /** Which status columns to render. Defaults to all. The "פעילות" tab passes the
   *  active statuses so completed issues don't appear on the board. */
  statuses?: IssueStatus[];
  /** When provided, a delete action is shown per card (RBAC-gated by the caller). */
  onDelete?: (issue: IssueWithMeta) => void;
}

export function IssuesKanban({ issues, canEdit, onSelect, onReorder, statuses, onDelete }: Props) {
  const [dragId, setDragId] = useState<string | null>(null);
  const [overCol, setOverCol] = useState<IssueStatus | null>(null);
  const [overIndex, setOverIndex] = useState<number | null>(null);

  const columns = statuses
    ? ISSUE_STATUSES.filter((c) => statuses.includes(c.value))
    : ISSUE_STATUSES;

  // Ordering: urgent first (pinned), then manual drag order (sort_order), then
  // creation order (issues have no due_date).
  const byStatus = (s: IssueStatus) =>
    issues
      .filter((i) => i.status === s)
      .sort((a, b) => {
        const au = a.priority === 'urgent' ? 0 : 1;
        const bu = b.priority === 'urgent' ? 0 : 1;
        if (au !== bu) return au - bu;
        if (a.sort_order !== b.sort_order) return a.sort_order - b.sort_order;
        return a.created_at.localeCompare(b.created_at);
      });

  // Build the destination column's new id order with the dragged card inserted
  // before the card at `index` (null → append), then persist.
  function dropInto(status: IssueStatus, index: number | null) {
    if (!dragId) return;
    const items = byStatus(status);
    const order = items.map((i) => i.id).filter((id) => id !== dragId);
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
                <span className={cn('h-2 w-2 rounded-full', ISSUE_STATUS_DOT[col.value])} />
                <h3 className="text-sm font-bold text-slate-700">{col.label}</h3>
              </div>
              <span className="inline-flex items-center justify-center rounded-full bg-white px-2 py-0.5 text-xs font-bold text-slate-500 ring-1 ring-slate-200">
                {items.length}
              </span>
            </div>

            <div className="flex flex-1 flex-col gap-2 p-3">
              {items.length === 0 && (
                <p className="py-6 text-center text-xs text-slate-400">אין תקלות</p>
              )}
              {items.map((i, idx) => (
                <div
                  key={i.id}
                  role="button"
                  tabIndex={0}
                  draggable={canEdit}
                  onDragStart={() => setDragId(i.id)}
                  onDragEnd={() => { setDragId(null); setOverCol(null); setOverIndex(null); }}
                  onDragOver={(e) => { if (canEdit && dragId && dragId !== i.id) { e.preventDefault(); e.stopPropagation(); setOverCol(col.value); setOverIndex(idx); } }}
                  onDrop={(e) => { e.stopPropagation(); dropInto(col.value, idx); }}
                  onClick={() => onSelect(i)}
                  onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); onSelect(i); } }}
                  className={cn(
                    'group w-full rounded-lg border border-slate-200 bg-white p-3 text-start shadow-[0_1px_2px_rgba(15,23,42,0.04)] transition-shadow hover:shadow-md',
                    canEdit && 'cursor-grab active:cursor-grabbing',
                    dragId === i.id && 'opacity-50',
                    overCol === col.value && overIndex === idx && dragId !== i.id && 'ring-2 ring-blue-300',
                  )}
                >
                  <div className="flex items-start justify-between gap-2">
                    <span className="text-sm font-semibold text-slate-900">{i.title}</span>
                    <div className="flex shrink-0 items-center gap-1">
                      {canEdit && (
                        <div className="flex items-center gap-0.5 opacity-0 transition-opacity group-hover:opacity-100">
                          <button
                            type="button"
                            aria-label="ערוך"
                            onClick={(e) => { e.stopPropagation(); onSelect(i); }}
                            className="grid h-7 w-7 place-items-center rounded-md text-slate-400 hover:bg-slate-100 hover:text-slate-700"
                          >
                            <Pencil className="h-3.5 w-3.5" />
                          </button>
                          {onDelete && (
                            <button
                              type="button"
                              aria-label="מחק"
                              onClick={(e) => { e.stopPropagation(); onDelete(i); }}
                              className="grid h-7 w-7 place-items-center rounded-md text-slate-400 hover:bg-rose-50 hover:text-rose-600"
                            >
                              <Trash2 className="h-3.5 w-3.5" />
                            </button>
                          )}
                        </div>
                      )}
                      <span className={cn('inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-medium', ISSUE_PRIORITY_BADGE[i.priority])}>
                        {issuePriorityLabel(i.priority)}
                      </span>
                    </div>
                  </div>
                  {i.description && (
                    <p className="mt-1 line-clamp-2 text-xs text-slate-500">{i.description}</p>
                  )}
                  <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-slate-400">
                    {i.assignees.length > 0 && <AssigneePills assignees={i.assignees} size="sm" />}
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
                </div>
              ))}
            </div>
          </div>
        );
      })}
    </div>
  );
}
