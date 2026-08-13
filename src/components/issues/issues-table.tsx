'use client';

import { ArrowDown, ArrowUp, MessageSquare, ImageIcon } from 'lucide-react';
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from '@/components/ui/table';
import { AssigneePills } from '@/components/assignee/AssigneePills';
import { TargetCell } from '@/components/targets/TargetCell';
import { RowActions } from '@/components/shared/RowActions';
import { cn } from '@/lib/utils';
import {
  ISSUE_STATUS_BADGE, ISSUE_PRIORITY_BADGE, issueStatusLabel, issuePriorityLabel,
} from '@/lib/constants/issues';
import type { IssueSort, IssueWithMeta } from '@/lib/types/issues';

interface Props {
  issues: IssueWithMeta[];
  sort: IssueSort;
  onSortChange: (s: IssueSort) => void;
  onSelect: (issue: IssueWithMeta) => void;
  /** When provided, a delete action is shown per row (RBAC-gated by the caller). */
  onDelete?: (issue: IssueWithMeta) => void;
}

export function IssuesTable({ issues, sort, onSortChange, onSelect, onDelete }: Props) {
  if (issues.length === 0) {
    return (
      <div className="rounded-lg border bg-card p-12 text-center text-sm text-muted-foreground">
        אין תקלות להצגה. דווח על תקלה חדשה כדי להתחיל.
      </div>
    );
  }

  return (
    <>
      {/* Mobile (<md) — one card per issue, mirroring the tasks table pattern. */}
      <ul className="space-y-2 roomy:hidden">
        {issues.map((i) => (
          <li key={i.id} className="relative rounded-xl border border-slate-200 bg-white p-3 shadow-soft-xs">
            <button
              type="button"
              onClick={() => onSelect(i)}
              aria-label={`פתיחת תקלה ${i.title}`}
              className="absolute inset-0 z-0 rounded-xl focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand"
            />
            <div className="relative z-10 flex items-start gap-2">
              <div className="pointer-events-none min-w-0 flex-1">
                <div className="flex min-w-0 flex-wrap items-center gap-1.5">
                  <span className="min-w-0 flex-1 text-[14.5px] font-medium text-slate-900">{i.title}</span>
                  {i.images.length > 0 && (
                    <span className="inline-flex items-center gap-0.5 text-[12px] text-slate-400">
                      <ImageIcon className="h-3.5 w-3.5" />
                      {i.images.length}
                    </span>
                  )}
                  {i.comment_count > 0 && (
                    <span className="inline-flex items-center gap-0.5 text-[12px] text-slate-400">
                      <MessageSquare className="h-3.5 w-3.5" />
                      {i.comment_count}
                    </span>
                  )}
                </div>
                <div className="mt-2 flex flex-wrap items-center gap-1.5">
                  <span className={cn('inline-flex items-center rounded-full px-2.5 py-0.5 text-[12px] font-medium', ISSUE_STATUS_BADGE[i.status])}>
                    {issueStatusLabel(i.status)}
                  </span>
                  <span className={cn('inline-flex items-center rounded-full px-2.5 py-0.5 text-[12px] font-medium', ISSUE_PRIORITY_BADGE[i.priority])}>
                    {issuePriorityLabel(i.priority)}
                  </span>
                  <span dir="ltr" className="text-[12.5px] tabular-nums text-slate-500">
                    {new Date(i.updated_at).toLocaleDateString('he-IL', { day: '2-digit', month: '2-digit', year: '2-digit' })}
                  </span>
                </div>
                <div className="mt-2 flex flex-wrap items-center gap-2">
                  <HandlerCell issue={i} />
                  <TargetCell type={i.target_type} label={i.target_label} />
                </div>
              </div>
              <div className="relative z-10 shrink-0">
                <RowActions onEdit={() => onSelect(i)} onDelete={onDelete ? () => onDelete(i) : undefined} />
              </div>
            </div>
          </li>
        ))}
      </ul>

      <div className="hidden overflow-hidden rounded-2xl border border-slate-200 bg-white roomy:block">
      <Table>
        <TableHeader className="[&_tr]:border-b [&_tr]:border-slate-200">
          <TableRow className="bg-slate-50/80 hover:bg-slate-50/80">
            <SortHead label="כותרת" col="created_desc" sort={sort} onSortChange={onSortChange} align="right" />
            <TableHead className="h-12 px-6 text-center text-[12.5px] font-bold text-slate-400">יעד</TableHead>
            <SortHead label="סטטוס" col="status_asc" sort={sort} onSortChange={onSortChange} align="center" />
            <SortHead label="דחיפות" col="priority_desc" sort={sort} onSortChange={onSortChange} align="center" />
            <TableHead className="h-12 px-6 text-center text-[12.5px] font-bold text-slate-400">מטפל</TableHead>
            <SortHead label="עודכן" col="updated_desc" sort={sort} onSortChange={onSortChange} align="center" />
            <TableHead className="h-12 px-6 text-center text-[12.5px] font-bold text-slate-400">פעולות</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {issues.map((i) => (
            <TableRow
              key={i.id}
              onClick={() => onSelect(i)}
              className="h-12 cursor-pointer border-b border-slate-100 hover:bg-slate-50"
            >
              <TableCell className="px-6 py-3.5 text-start text-sm">
                <div className="flex items-center gap-2">
                  <span className="font-medium text-slate-900">{i.title}</span>
                  {i.images.length > 0 && (
                    <span className="inline-flex items-center gap-0.5 text-xs text-slate-400">
                      <ImageIcon className="h-3.5 w-3.5" />
                      {i.images.length}
                    </span>
                  )}
                  {i.comment_count > 0 && (
                    <span className="inline-flex items-center gap-0.5 text-xs text-slate-400">
                      <MessageSquare className="h-3.5 w-3.5" />
                      {i.comment_count}
                    </span>
                  )}
                </div>
              </TableCell>
              <TableCell className="px-6 py-3.5 text-center text-sm">
                <TargetCell type={i.target_type} label={i.target_label} />
              </TableCell>
              <TableCell className="px-6 py-3.5 text-center text-sm">
                <span className={cn('inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium', ISSUE_STATUS_BADGE[i.status])}>
                  {issueStatusLabel(i.status)}
                </span>
              </TableCell>
              <TableCell className="px-6 py-3.5 text-center text-sm">
                <span className={cn('inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium', ISSUE_PRIORITY_BADGE[i.priority])}>
                  {issuePriorityLabel(i.priority)}
                </span>
              </TableCell>
              <TableCell className="px-6 py-3.5 text-center text-sm">
                <HandlerCell issue={i} />
              </TableCell>
              <TableCell dir="ltr" className="px-6 py-3.5 text-center text-sm tabular-nums text-slate-500">
                {new Date(i.updated_at).toLocaleDateString('he-IL', { day: '2-digit', month: '2-digit', year: '2-digit' })}
              </TableCell>
              <TableCell className="px-6 py-3.5 text-center text-sm">
                <RowActions onEdit={() => onSelect(i)} onDelete={onDelete ? () => onDelete(i) : undefined} />
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
      </div>
    </>
  );
}

/** Handler cell — the issue's mixed assignees as pills (users + suppliers). */
function HandlerCell({ issue: i }: { issue: IssueWithMeta }) {
  return <AssigneePills assignees={i.assignees} />;
}

function SortHead({
  label, col, sort, onSortChange, align,
}: {
  label: string;
  col: IssueSort;
  sort: IssueSort;
  onSortChange: (s: IssueSort) => void;
  align: 'right' | 'center';
}) {
  const active = sort === col;
  return (
    <TableHead className={cn('h-12 px-6 text-[12.5px] font-bold text-slate-400', align === 'right' ? 'text-start' : 'text-center')}>
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
