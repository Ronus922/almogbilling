'use client';

import { ArrowDown, ArrowUp, MessageSquare } from 'lucide-react';
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from '@/components/ui/table';
import { AssigneePills } from '@/components/assignee/AssigneePills';
import { TargetCell } from '@/components/targets/TargetCell';
import { cn } from '@/lib/utils';
import {
  STATUS_BADGE, PRIORITY_BADGE, taskStatusLabel, taskPriorityLabel,
} from '@/lib/constants/tasks';
import type { TaskSort, TaskWithAssignee } from '@/lib/types/tasks';

interface Props {
  tasks: TaskWithAssignee[];
  sort: TaskSort;
  onSortChange: (s: TaskSort) => void;
  onSelect: (task: TaskWithAssignee) => void;
}

function isOverdue(t: TaskWithAssignee): boolean {
  if (!t.due_date) return false;
  if (t.status === 'done' || t.status === 'cancelled') return false;
  return t.due_date < new Date().toISOString().slice(0, 10);
}

export function TasksTable({ tasks, sort, onSortChange, onSelect }: Props) {
  if (tasks.length === 0) {
    return (
      <div className="rounded-lg border bg-card p-12 text-center text-sm text-muted-foreground">
        אין משימות להצגה. צור משימה חדשה כדי להתחיל.
      </div>
    );
  }

  return (
    <div className="overflow-hidden rounded-lg border border-slate-200 bg-white">
      <Table>
        <TableHeader className="[&_tr]:border-b [&_tr]:border-slate-200">
          <TableRow className="bg-slate-50 hover:bg-slate-50">
            <SortHead label="כותרת" col="created_desc" sort={sort} onSortChange={onSortChange} align="right" />
            <TableHead className="h-11 px-4 text-center text-sm font-semibold text-slate-500">סטטוס</TableHead>
            <SortHead label="עדיפות" col="priority_desc" sort={sort} onSortChange={onSortChange} align="center" />
            <SortHead label="תאריך יעד" col="due_asc" sort={sort} onSortChange={onSortChange} align="center" />
            <TableHead className="h-11 px-4 text-center text-sm font-semibold text-slate-500">מטפל</TableHead>
            <TableHead className="h-11 px-4 text-center text-sm font-semibold text-slate-500">יעד</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {tasks.map((t) => (
            <TableRow
              key={t.id}
              onClick={() => onSelect(t)}
              className="h-12 cursor-pointer border-b border-slate-100 hover:bg-slate-50"
            >
              <TableCell className="px-4 py-3 text-right text-sm">
                <div className="flex items-center gap-2">
                  <span className="font-medium text-slate-900">{t.title}</span>
                  {t.comment_count > 0 && (
                    <span className="inline-flex items-center gap-0.5 text-xs text-slate-400">
                      <MessageSquare className="h-3.5 w-3.5" />
                      {t.comment_count}
                    </span>
                  )}
                </div>
              </TableCell>
              <TableCell className="px-4 py-3 text-center text-sm">
                <span className={cn('inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium', STATUS_BADGE[t.status])}>
                  {taskStatusLabel(t.status)}
                </span>
              </TableCell>
              <TableCell className="px-4 py-3 text-center text-sm">
                <span className={cn('inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium', PRIORITY_BADGE[t.priority])}>
                  {taskPriorityLabel(t.priority)}
                </span>
              </TableCell>
              <TableCell dir="ltr" className={cn('px-4 py-3 text-center text-sm tabular-nums', isOverdue(t) ? 'font-bold text-rose-600' : 'text-slate-600')}>
                {t.due_date ?? '—'}
              </TableCell>
              <TableCell className="px-4 py-3 text-center text-sm">
                <HandlerCell task={t} />
              </TableCell>
              <TableCell className="px-4 py-3 text-center text-sm">
                <TargetCell type={t.target_type} label={t.target_label} />
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
    <TableHead className={cn('h-11 px-4 text-sm font-semibold text-slate-500', align === 'right' ? 'text-right' : 'text-center')}>
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
