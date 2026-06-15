'use client';

import { CalendarClock, User, Tag, Trash2, AlarmClockOff } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { UserReminderWithNames } from '@/lib/types/userReminders';
import {
  reminderStatusLabel, reminderStatusDot, reminderStatusText, UNCATEGORIZED_COLOR,
} from '@/lib/constants/userReminders';
import { formatRemindAt } from './helpers';

interface Props {
  reminder: UserReminderWithNames;
  canEdit: boolean;
  /** True when remind_at is in the past and the reminder is still pending. */
  overdue: boolean;
  onOpen: () => void;
  onDelete: () => void;
}

export function ReminderCard({ reminder: r, canEdit, overdue, onOpen, onDelete }: Props) {
  const stripe = r.category_color ?? UNCATEGORIZED_COLOR;

  return (
    <div
      role="button"
      tabIndex={0}
      onClick={onOpen}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onOpen();
        }
      }}
      className="group relative flex cursor-pointer items-start gap-3 overflow-hidden rounded-lg border border-slate-200 bg-white p-4 ps-5 text-start transition-colors hover:bg-slate-50"
    >
      {/* Category color side-stripe (start edge = right in RTL). Physical inset
          is intentional here — it hugs the card edge regardless of direction. */}
      <span
        aria-hidden
        className="absolute inset-y-0 start-0 w-1.5"
        style={{ backgroundColor: stripe }}
      />

      {/* Status indicator dot */}
      <span
        className={cn('mt-1.5 h-2.5 w-2.5 shrink-0 rounded-full', reminderStatusDot(r.status))}
        aria-hidden
      />

      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <h3 className="truncate text-base font-semibold text-slate-900">{r.title}</h3>
          {overdue && (
            <span className="inline-flex items-center gap-1 rounded-full bg-rose-50 px-2 py-0.5 text-[11px] font-semibold text-rose-600">
              <AlarmClockOff className="h-3 w-3" /> באיחור
            </span>
          )}
        </div>

        {/* Secondary meta line (the card "description") */}
        <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-slate-500">
          <span className="inline-flex items-center gap-1">
            <CalendarClock className="h-3.5 w-3.5 text-slate-400" />
            <span dir="ltr" className="font-num tabular-nums">{formatRemindAt(r.remind_at)}</span>
          </span>
          {r.category_name && (
            <span className="inline-flex items-center gap-1">
              <Tag className="h-3.5 w-3.5 text-slate-400" />
              {r.category_name}
            </span>
          )}
          {r.assigned_to_name && (
            <span className="inline-flex items-center gap-1">
              <User className="h-3.5 w-3.5 text-slate-400" />
              {r.assigned_to_name}
            </span>
          )}
          <span className={cn('inline-flex items-center gap-1 font-medium', reminderStatusText(r.status))}>
            {reminderStatusLabel(r.status)}
          </span>
        </div>
      </div>

      {canEdit && (
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            onDelete();
          }}
          aria-label="מחיקת תזכורת"
          className="grid h-9 w-9 shrink-0 place-items-center rounded-lg text-slate-400 opacity-0 transition-all hover:bg-rose-50 hover:text-rose-600 focus-visible:opacity-100 group-hover:opacity-100"
        >
          <Trash2 className="h-4 w-4" />
        </button>
      )}
    </div>
  );
}
