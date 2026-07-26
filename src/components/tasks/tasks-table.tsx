'use client';

import { ArrowDown, ArrowUp, MessageSquare } from 'lucide-react';
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from '@/components/ui/table';
import { AssigneePills } from '@/components/assignee/AssigneePills';
import { TargetCell } from '@/components/targets/TargetCell';
import { RowActions } from '@/components/shared/RowActions';
import { RecurringBadge } from '@/components/recurrence/RecurringBadge';
import { CadenceStrip, CadenceProgress } from '@/components/recurrence/CadenceStrip';
import { cn } from '@/lib/utils';
import {
  STATUS_BADGE, PRIORITY_BADGE, taskStatusLabel, taskPriorityLabel,
} from '@/lib/constants/tasks';
import type { TaskSort, TaskWithAssignee } from '@/lib/types/tasks';
import { todayInJerusalem } from '@/lib/dates';

interface Props {
  tasks: TaskWithAssignee[];
  sort: TaskSort;
  onSortChange: (s: TaskSort) => void;
  onSelect: (task: TaskWithAssignee) => void;
  /** When provided, a delete action is shown per row (RBAC-gated by the caller). */
  onDelete?: (task: TaskWithAssignee) => void;
}

function isOverdue(t: TaskWithAssignee): boolean {
  if (!t.due_date) return false;
  if (t.status === 'done' || t.status === 'cancelled') return false;
  // "today" anchored to Jerusalem (server runs UTC) so the overdue class matches
  // between SSR and hydration.
  return t.due_date < todayInJerusalem();
}

export function TasksTable({ tasks, sort, onSortChange, onSelect, onDelete }: Props) {
  if (tasks.length === 0) {
    return (
      <div className="rounded-lg border bg-card p-12 text-center text-sm text-muted-foreground">
        אין משימות להצגה. צור משימה חדשה כדי להתחיל.
      </div>
    );
  }

  return (
    <div className="overflow-hidden rounded-2xl border border-slate-200 bg-white">
      <Table>
        <TableHeader className="[&_tr]:border-b [&_tr]:border-slate-200">
          <TableRow className="bg-slate-50/80 hover:bg-slate-50/80">
            <SortHead label="כותרת" col="created_desc" sort={sort} onSortChange={onSortChange} align="right" />
            <TableHead className="h-12 px-6 text-center text-[12.5px] font-bold text-slate-400">סטטוס</TableHead>
            <SortHead label="עדיפות" col="priority_desc" sort={sort} onSortChange={onSortChange} align="center" />
            <SortHead label="תאריך יעד" col="due_asc" sort={sort} onSortChange={onSortChange} align="center" />
            <TableHead className="hidden h-12 px-6 text-center text-[12.5px] font-bold text-slate-400 lg:table-cell">מחזוריות</TableHead>
            <TableHead className="h-12 px-6 text-center text-[12.5px] font-bold text-slate-400">מטפל</TableHead>
            <TableHead className="h-12 px-6 text-center text-[12.5px] font-bold text-slate-400">יעד</TableHead>
            <TableHead className="h-12 px-6 text-center text-[12.5px] font-bold text-slate-400">פעולות</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {tasks.map((t) => (
            <TableRow
              key={t.id}
              onClick={() => onSelect(t)}
              className="h-12 cursor-pointer border-b border-slate-100 hover:bg-slate-50"
            >
              <TableCell className="px-6 py-3.5 text-right text-sm">
                <div className="flex items-center gap-2">
                  <span className="font-medium text-slate-900">{t.title}</span>
                  {t.recurrence && <RecurringBadge />}
                  {t.recurrence && (
                    <CadenceProgress
                      doneCount={t.recurrence.done_count}
                      expectedCount={t.recurrence.expected_count}
                      periodLabel={t.recurrence.period_label}
                    />
                  )}
                  {t.comment_count > 0 && (
                    <span className="inline-flex items-center gap-0.5 text-xs text-slate-400">
                      <MessageSquare className="h-3.5 w-3.5" />
                      {t.comment_count}
                    </span>
                  )}
                </div>
              </TableCell>
              <TableCell className="px-6 py-3.5 text-center text-sm">
                <span className={cn('inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium', STATUS_BADGE[t.status])}>
                  {taskStatusLabel(t.status)}
                </span>
              </TableCell>
              <TableCell className="px-6 py-3.5 text-center text-sm">
                <span className={cn('inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium', PRIORITY_BADGE[t.priority])}>
                  {taskPriorityLabel(t.priority)}
                </span>
              </TableCell>
              <TableCell dir="ltr" className={cn('px-6 py-3.5 text-center text-sm tabular-nums', isOverdue(t) ? 'font-bold text-rose-600' : 'text-slate-600')}>
                {t.due_date ?? '—'}
              </TableCell>
              <TableCell className="hidden px-6 py-3.5 text-right text-sm lg:table-cell">
                {t.recurrence && t.recurrence.chips.type !== 'none' ? (
                  <CadenceStrip label={t.recurrence.label} chips={t.recurrence.chips} />
                ) : (
                  <span className="block text-center text-slate-300">—</span>
                )}
              </TableCell>
              <TableCell className="px-6 py-3.5 text-center text-sm">
                <HandlerCell task={t} />
              </TableCell>
              <TableCell className="px-6 py-3.5 text-center text-sm">
                <TargetCell type={t.target_type} label={t.target_label} />
              </TableCell>
              <TableCell className="px-6 py-3.5 text-center text-sm">
                <RowActions onEdit={() => onSelect(t)} onDelete={onDelete ? () => onDelete(t) : undefined} />
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}

/** Handler cell — the task's mixed assignees as pills (users + suppliers). */
function HandlerCell({ task: t }: { task: TaskWithAssignee }) {
  return <AssigneePills assignees={t.assignees} />;
}

function SortHead({
  label, col, sort, onSortChange, align,
}: {
  label: string;
  col: TaskSort;
  sort: TaskSort;
  onSortChange: (s: TaskSort) => void;
  align: 'right' | 'center';
}) {
  const active = sort === col;
  return (
    <TableHead className={cn('h-12 px-6 text-[12.5px] font-bold text-slate-400', align === 'right' ? 'text-right' : 'text-center')}>
      <button
        type="button"
        onClick={() => onSortChange(col)}
        className={cn('group inline-flex items-center gap-1 cursor-pointer', active ? 'text-slate-700' : 'hover:text-slate-700')}
      >
        {label}
        {active ? <ArrowDown className="h-3.5 w-3.5 opacity-100" /> : <ArrowUp className="h-3.5 w-3.5 opacity-0 group-hover:opacity-40" />}
      </button>
    </TableHead>
  );
}
