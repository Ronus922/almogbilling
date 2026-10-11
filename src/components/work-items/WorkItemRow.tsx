'use client';

// Unified תקלות/משימות module (11/10/2026) — one row in the list view.
// Card/row color = priority only (DESIGN.md "שפת צבעים — תקלות ומשימות");
// status is a chip, never a background.

import { useState } from 'react';
import { AlertOctagon, MessageSquare, Paperclip, Repeat, UserPlus } from 'lucide-react';
import { cn } from '@/lib/utils';
import {
  WORK_PRIORITY_TAG, WORK_PRIORITY_LABEL, WORK_STATUS_DOT, WORK_STATUS_LABEL,
  WORK_NEW_TAG, WORK_BLOCKED_TAG, WORK_OVERDUE_TEXT, WORK_RESIDENT_TAG,
  WORK_KIND_TAG, WORK_KIND_LABEL, WORK_AVATAR,
} from '@/lib/constants/workItems';
import { PrimaryAssigneePicker } from './PrimaryAssigneePicker';
import { BlockedToggleDialog } from './BlockedToggleDialog';
import type { WorkItem } from '@/lib/types/workItems';

function isOverdue(item: WorkItem, todayStr: string): boolean {
  return !!item.due_date && item.due_date < todayStr && item.status_v2 !== 'closed';
}

/** 'YYYY-MM-DD' → 'DD/MM'. */
function fmtDate(d: string): string {
  const [, m, day] = d.split('-');
  return `${day}/${m}`;
}

export function WorkItemRow({
  item,
  today,
  canEdit,
  employees,
  suppliers,
  onOpen,
  onAssign,
  onAdvanceStatus,
  onBlockedChange,
}: {
  item: WorkItem;
  today: string;
  canEdit: boolean;
  employees: { id: string; name: string }[];
  suppliers: { id: string; display_name: string }[];
  onOpen: () => void;
  onAssign: (assignee: { kind: 'user' | 'supplier'; id: string } | null) => void;
  onAdvanceStatus: () => void;
  onBlockedChange: (blocked: boolean, reason: string | null) => void;
}) {
  const overdue = isOverdue(item, today);
  const [blockedDialogOpen, setBlockedDialogOpen] = useState(false);

  return (
    <div
      role="button"
      tabIndex={0}
      onClick={onOpen}
      onKeyDown={(e) => { if (e.key === 'Enter') onOpen(); }}
      className={cn(
        'flex w-full items-center gap-3 rounded-xl border bg-white px-4 py-3 text-start shadow-[0_1px_2px_rgba(15,23,42,0.04)] transition-colors hover:border-slate-300',
        item.priority === 'urgent' && 'border-rose-300 bg-rose-50',
        item.priority === 'high' && 'border-amber-300 bg-amber-50',
        item.priority === 'normal' && 'border-slate-200',
      )}
    >
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-1.5">
          {item.is_new && (
            <span className={cn('rounded-md px-1.5 py-0.5 text-[10.5px] font-bold', WORK_NEW_TAG)}>חדש</span>
          )}
          {WORK_PRIORITY_TAG[item.priority] && (
            <span className={cn('rounded-md px-1.5 py-0.5 text-[10.5px] font-bold', WORK_PRIORITY_TAG[item.priority])}>
              {WORK_PRIORITY_LABEL[item.priority]}
            </span>
          )}
          <span className={cn('rounded-md px-1.5 py-0.5 text-[10.5px] font-bold', WORK_KIND_TAG[item.kind])}>
            {WORK_KIND_LABEL[item.kind]}
          </span>
          {item.blocked && (
            <button
              type="button"
              disabled={!canEdit}
              onClick={(e) => { e.stopPropagation(); setBlockedDialogOpen(true); }}
              className={cn('rounded-md px-1.5 py-0.5 text-[10.5px] font-bold', WORK_BLOCKED_TAG)}
            >
              תקוע{item.blocked_reason ? ` · ${item.blocked_reason}` : ''}
            </button>
          )}
          {item.is_from_resident && (
            <span className={cn('rounded-md px-1.5 py-0.5 text-[10.5px] font-bold', WORK_RESIDENT_TAG)}>
              דייר{item.source_apartment ? ` · דירה ${item.source_apartment}` : ''}
              {item.source_reporter_name ? ` · ${item.source_reporter_name}` : ''}
            </span>
          )}
          {item.is_recurring && (
            <span className="inline-flex items-center gap-1 rounded-md bg-slate-100 px-1.5 py-0.5 text-[10.5px] font-bold text-slate-600">
              <Repeat className="h-3 w-3" />
              מחזורית{item.is_recurring_paused ? ' · מושהה' : ''}
            </span>
          )}
        </div>
        <h3 className="mt-1 truncate text-[14.5px] font-bold text-slate-900">{item.title}</h3>
        <div className="mt-0.5 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-[11.5px] text-slate-400">
          {item.comment_count > 0 && (
            <span className="inline-flex items-center gap-0.5"><MessageSquare className="h-3 w-3" />{item.comment_count}</span>
          )}
          {item.attachment_count > 0 && (
            <span className="inline-flex items-center gap-0.5"><Paperclip className="h-3 w-3" />{item.attachment_count}</span>
          )}
        </div>
      </div>

      {/* Assignee — avatar+name, or quick-assign button */}
      <div onClick={(e) => e.stopPropagation()} className="shrink-0">
        <PrimaryAssigneePicker
          value={item.assignee}
          employees={employees}
          suppliers={suppliers}
          onChange={onAssign}
          disabled={!canEdit}
          trigger={
            item.assignee ? (
              <span className="flex items-center gap-1.5 rounded-full px-2 py-1 text-[12px] font-semibold text-slate-700 hover:bg-row-hover">
                <span className={cn('grid h-6 w-6 place-items-center rounded-full text-[11px] font-bold', WORK_AVATAR)}>
                  {item.assignee.display_name.slice(0, 1)}
                </span>
                <span className="max-w-[110px] truncate">{item.assignee.display_name}</span>
              </span>
            ) : (
              <span className="flex items-center gap-1 rounded-full border border-dashed border-slate-300 px-2.5 py-1 text-[12px] font-semibold text-slate-500 hover:border-slate-400">
                <UserPlus className="h-3.5 w-3.5" />
                שיוך מהיר
              </span>
            )
          }
        />
      </div>

      {/* Due date */}
      <div className="w-16 shrink-0 text-end text-[12px] font-semibold">
        {item.due_date ? (
          <span dir="ltr" className={cn('tabular-nums', overdue ? WORK_OVERDUE_TEXT : 'text-slate-600')}>
            {fmtDate(item.due_date)}
          </span>
        ) : (
          <span className="text-slate-300">— ללא יעד</span>
        )}
      </div>

      {/* Status chip — click advances open -> in_progress -> closed */}
      <button
        type="button"
        disabled={!canEdit || item.status_v2 === 'closed'}
        onClick={(e) => { e.stopPropagation(); onAdvanceStatus(); }}
        className="inline-flex shrink-0 items-center gap-1.5 rounded-full bg-slate-100 px-2.5 py-1 text-[12px] font-semibold text-slate-700 disabled:cursor-default"
      >
        <span className={cn('h-1.5 w-1.5 rounded-full', WORK_STATUS_DOT[item.status_v2])} />
        {WORK_STATUS_LABEL[item.status_v2]}
      </button>

      {canEdit && !item.blocked && (
        <button
          type="button"
          aria-label='סמן כתקוע'
          onClick={(e) => { e.stopPropagation(); setBlockedDialogOpen(true); }}
          className="grid h-8 w-8 shrink-0 place-items-center rounded-full text-slate-400 hover:bg-red-50 hover:text-red-600"
        >
          <AlertOctagon className="h-4 w-4" />
        </button>
      )}

      <BlockedToggleDialog
        open={blockedDialogOpen}
        onOpenChange={setBlockedDialogOpen}
        kind={item.kind}
        id={item.id}
        currentlyBlocked={item.blocked}
        currentReason={item.blocked_reason}
        onDone={onBlockedChange}
      />
    </div>
  );
}
