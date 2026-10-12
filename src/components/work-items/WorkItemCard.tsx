'use client';

// תקלות/משימות — the kanban card (12/10/2026, pixel-exact adoption of
// ref/issues-board.html `.card`): priority-only background (no status chip,
// no kind tag — DESIGN.md §41), dotted drag handle + divider, bottom line
// "נוצר ע״י X · DD.MM · HH:MM" (green for a resident report), a floating
// hover action panel (done/edit/delete), and the multi-assignee avatar stack.
// `variant="ucard"` renders the compact horizontal row used by the
// "ממתינים לשיבוץ" strip (ref `.ucard`) — same color/handle rules, an inline
// "שיבוץ" button instead of the vertical card body.

import { AlertOctagon, Check, Pencil, Trash2 } from 'lucide-react';
import { cn } from '@/lib/utils';
import {
  WORK_PRIORITY_CARD, WORK_NEW_TAG, WORK_BLOCKED_TAG, WORK_RESIDENT_TAG,
} from '@/lib/constants/workItems';
import { AssigneeAvatarStack } from './AssigneeAvatarStack';
import { PrimaryAssigneePicker } from './PrimaryAssigneePicker';
import type { WorkItem } from '@/lib/types/workItems';

/** 'YYYY-MM-DDTHH:mm:ss...' → 'DD.MM · HH:MM' (Asia/Jerusalem). */
function fmtCreated(iso: string): string {
  const d = new Date(iso);
  const parts = new Intl.DateTimeFormat('he-IL', {
    timeZone: 'Asia/Jerusalem', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false,
  }).formatToParts(d);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '';
  return `${get('day')}.${get('month')} · ${get('hour')}:${get('minute')}`;
}

export function WorkItemCard({
  item,
  canEdit,
  employees,
  suppliers,
  onOpen,
  onAssign,
  onMarkDone,
  onBlockedClick,
  onDelete,
  draggable,
  onDragStart,
  onDragEnd,
  ring,
  variant = 'card',
}: {
  item: WorkItem;
  canEdit: boolean;
  employees: { id: string; name: string }[];
  suppliers: { id: string; display_name: string }[];
  onOpen: () => void;
  onAssign: (assignee: { kind: 'user' | 'supplier'; id: string } | null) => void;
  onMarkDone: () => void;
  onBlockedClick: () => void;
  onDelete: () => void;
  draggable?: boolean;
  onDragStart?: (e: React.DragEvent) => void;
  onDragEnd?: () => void;
  ring?: boolean;
  variant?: 'card' | 'ucard';
}) {
  const tone = WORK_PRIORITY_CARD[item.priority];

  if (variant === 'ucard') {
    return (
      <div
        data-work-item-id={item.id}
        draggable={draggable}
        onDragStart={onDragStart}
        onDragEnd={onDragEnd}
        onClick={onOpen}
        role="button"
        tabIndex={0}
        onKeyDown={(e) => { if (e.key === 'Enter') onOpen(); }}
        className={cn(
          'wb-handle relative flex items-center gap-3 rounded-[11px] border bg-white py-2.5 ps-6 pe-3 shadow-soft-xs transition-[box-shadow,transform] duration-150 hover:-translate-y-px hover:shadow-soft-md',
          tone,
          ring && 'ring-2 ring-brand/40',
        )}
      >
        <h4 className="min-w-0 flex-1 truncate text-[13.5px] font-semibold text-ink">{item.title}</h4>
        {canEdit ? (
          <PrimaryAssigneePicker
            value={item.assignee}
            employees={employees}
            suppliers={suppliers}
            onChange={onAssign}
            trigger={
              <span
                onClick={(e) => e.stopPropagation()}
                className="inline-flex shrink-0 cursor-pointer items-center rounded-lg border border-brand-border bg-brand-soft px-3 py-1.5 text-[12.5px] font-bold text-brand-text transition-colors hover:bg-[#DDE3FF]"
              >
                שיבוץ
              </span>
            }
          />
        ) : null}
      </div>
    );
  }

  return (
    <div
      data-work-item-id={item.id}
      draggable={draggable}
      onDragStart={onDragStart}
      onDragEnd={onDragEnd}
      onClick={onOpen}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => { if (e.key === 'Enter') onOpen(); }}
      className={cn(
        'wb-handle group relative flex min-h-[96px] flex-none flex-col gap-2 rounded-[11px] border bg-white py-[11px] ps-[23px] pe-3 text-start shadow-soft-xs transition-[box-shadow,transform,border-color] duration-150 hover:-translate-y-0.5 hover:border-line-strong hover:shadow-[0_6px_18px_rgba(20,28,50,0.1)]',
        tone,
        ring && 'ring-2 ring-brand/40',
      )}
    >
      {(item.is_new || item.blocked || item.is_from_resident || (item.is_recurring)) && (
        <div className="flex flex-wrap items-center gap-1.5">
          {item.is_new && <span className={cn('rounded-md px-1.5 py-0.5 text-[10px] font-bold', WORK_NEW_TAG)}>חדש</span>}
          {item.blocked && (
            <button
              type="button"
              disabled={!canEdit}
              onClick={(e) => { e.stopPropagation(); onBlockedClick(); }}
              className={cn('rounded-md px-1.5 py-0.5 text-[10px] font-bold', WORK_BLOCKED_TAG)}
            >
              תקוע{item.blocked_reason ? ` · ${item.blocked_reason}` : ''}
            </button>
          )}
          {item.is_from_resident && (
            <span className={cn('rounded-md px-1.5 py-0.5 text-[10px] font-bold', WORK_RESIDENT_TAG)}>
              דייר{item.source_apartment ? ` · דירה ${item.source_apartment}` : ''}
            </span>
          )}
          {item.is_recurring && (
            <span className="rounded-md bg-line-soft px-1.5 py-0.5 text-[10px] font-bold text-ink-2">
              מחזורית{item.is_recurring_paused ? ' · מושהה' : ''}
            </span>
          )}
        </div>
      )}

      <h4 className="line-clamp-2 text-[13.5px] font-semibold leading-[1.45] text-ink">{item.title}</h4>

      <div className="mt-auto flex items-center gap-2 pt-0.5">
        <span className={cn('text-[10px] font-medium', item.is_from_resident ? 'text-[#0C7A37]' : 'text-ink-ghost')}>
          {item.is_from_resident
            ? `נוצר ע״י דייר — דירה ${item.source_apartment ?? '—'}`
            : `נוצר ע״י ${item.created_by_name ?? '—'}`} ·{' '}
          <span className="font-num" dir="ltr">{fmtCreated(item.created_at)}</span>
        </span>
        <AssigneeAvatarStack assignees={item.assignees} primary={item.assignee} />
      </div>

      {canEdit && (
        <div
          onClick={(e) => e.stopPropagation()}
          className="absolute end-[7px] top-[7px] flex gap-0.5 rounded-[9px] border border-line bg-white p-[3px] opacity-0 shadow-[0_5px_14px_rgba(20,28,50,0.14)] transition-opacity duration-150 group-hover:opacity-100"
        >
          <button
            type="button"
            title="סמן כבוצע"
            disabled={item.status_v2 === 'closed'}
            onClick={onMarkDone}
            className="grid h-[27px] w-[27px] place-items-center rounded-md text-ink-3 transition-colors hover:bg-[#E9FBF0] hover:text-[#0C7A37] disabled:opacity-40"
          >
            <Check className="h-[15px] w-[15px]" />
          </button>
          <button
            type="button"
            title="עריכה"
            onClick={onOpen}
            className="grid h-[27px] w-[27px] place-items-center rounded-md text-ink-3 transition-colors hover:bg-row-hover hover:text-ink"
          >
            <Pencil className="h-3.5 w-3.5" />
          </button>
          <button
            type="button"
            title="מחיקה"
            onClick={onDelete}
            className="grid h-[27px] w-[27px] place-items-center rounded-md text-ink-3 transition-colors hover:bg-[#FEEFEF] hover:text-[#B01B20]"
          >
            <Trash2 className="h-3.5 w-3.5" />
          </button>
          {/* Not in the reference's 3-icon panel — kept so "תקוע" stays settable
             at all: the full edit panel has no blocked field, so this quick
             action is the ONLY way in (DESIGN.md §41 exception, 12/10/2026). */}
          {!item.blocked && (
            <button
              type="button"
              title="סמן כתקוע"
              onClick={onBlockedClick}
              className="grid h-[27px] w-[27px] place-items-center rounded-md text-ink-3 transition-colors hover:bg-[#FEEFEF] hover:text-[#B01B20]"
            >
              <AlertOctagon className="h-3.5 w-3.5" />
            </button>
          )}
        </div>
      )}
    </div>
  );
}
