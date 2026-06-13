'use client';

import { CheckSquare, Clock, MapPin, Repeat } from 'lucide-react';
import { cn } from '@/lib/utils';
import {
  HE_DAY_NAMES, HE_DAY_NAMES_SHORT,
} from '@/lib/constants/calendar';
import { eventBlockClasses } from '@/lib/constants/calendar';
import {
  monthGridDays, weekDays, toDateKey, isSameDay, isSameMonth, todayKey,
} from '@/lib/calendar/dates';
import type { CalendarItem } from '@/lib/types/calendar';

export type CalendarView = 'month' | 'week' | 'day';

interface ViewProps {
  cursor: Date;
  items: CalendarItem[];
  onSelectDay: (dateKey: string) => void;
  onSelectItem: (item: CalendarItem) => void;
}

/** Group items by their event_date key for O(1) per-cell lookup. */
function groupByDate(items: CalendarItem[]): Map<string, CalendarItem[]> {
  const m = new Map<string, CalendarItem[]>();
  for (const it of items) {
    const arr = m.get(it.event_date) ?? [];
    arr.push(it);
    m.set(it.event_date, arr);
  }
  return m;
}

function timeLabel(item: CalendarItem): string | null {
  if (item.kind === 'task') return item.due_time;
  if (item.is_all_day || !item.start_datetime) return null;
  const d = new Date(item.start_datetime);
  if (Number.isNaN(d.getTime())) return null;
  return d.toLocaleTimeString('he-IL', { hour: '2-digit', minute: '2-digit' });
}

// ── Shared event chip ────────────────────────────────────────────────────────
function EventChip({
  item, onSelect, compact = false,
}: { item: CalendarItem; onSelect: () => void; compact?: boolean }) {
  const t = timeLabel(item);
  if (item.kind === 'task') {
    return (
      <button
        type="button"
        onClick={(e) => { e.stopPropagation(); onSelect(); }}
        title={`משימה: ${item.title}`}
        className={cn(
          'flex w-full items-center gap-1 truncate rounded-md border px-1.5 py-0.5 text-start text-[11px] font-medium transition-colors',
          'border-dashed border-slate-300 bg-slate-50 text-slate-600 hover:bg-slate-100',
        )}
      >
        <CheckSquare className="h-3 w-3 shrink-0 text-slate-500" />
        {t && <span dir="ltr" className="shrink-0 tabular-nums text-[10px] text-slate-400">{t}</span>}
        <span className="truncate">
          <span className="font-semibold text-slate-400">משימה · </span>
          {item.title}
        </span>
      </button>
    );
  }
  return (
    <button
      type="button"
      onClick={(e) => { e.stopPropagation(); onSelect(); }}
      title={item.title}
      className={cn(
        'flex w-full items-center gap-1 truncate rounded-md border px-1.5 py-0.5 text-start text-[11px] font-semibold transition-opacity hover:opacity-85',
        eventBlockClasses(item.color_key),
        item.status === 'cancelled' && 'line-through opacity-60',
      )}
    >
      {item.recurrence_enabled && <Repeat className="h-2.5 w-2.5 shrink-0 opacity-70" />}
      {t && <span dir="ltr" className="shrink-0 tabular-nums text-[10px] opacity-80">{t}</span>}
      <span className="truncate">{item.title}</span>
      {!compact && item.location && <MapPin className="h-2.5 w-2.5 shrink-0 opacity-60" />}
    </button>
  );
}

// ── Month view ───────────────────────────────────────────────────────────────
export function MonthView({ cursor, items, onSelectDay, onSelectItem }: ViewProps) {
  const days = monthGridDays(cursor);
  const byDate = groupByDate(items);
  const tKey = todayKey();
  const MAX_VISIBLE = 3;

  return (
    <div className="overflow-hidden rounded-lg border border-slate-200 bg-white">
      {/* Day-of-week header (Sunday-first, RTL → Sunday on the right) */}
      <div className="grid grid-cols-7 border-b border-slate-200 bg-slate-50">
        {HE_DAY_NAMES.map((name) => (
          <div key={name} className="px-2 py-2 text-center text-xs font-semibold text-slate-500">
            {name}
          </div>
        ))}
      </div>
      <div className="grid grid-cols-7">
        {days.map((day, idx) => {
          const key = toDateKey(day);
          const dayItems = byDate.get(key) ?? [];
          const inMonth = isSameMonth(day, cursor);
          const isToday = key === tKey;
          const extra = dayItems.length - MAX_VISIBLE;
          return (
            <button
              key={key + idx}
              type="button"
              onClick={() => onSelectDay(key)}
              className={cn(
                'flex min-h-[104px] flex-col gap-1 border-b border-l border-slate-100 p-1.5 text-start transition-colors last:border-l-0 hover:bg-slate-50',
                !inMonth && 'bg-slate-50/50',
              )}
            >
              <span
                className={cn(
                  'mb-0.5 inline-flex h-6 w-6 items-center justify-center self-end rounded-full text-xs tabular-nums',
                  isToday ? 'bg-blue-600 font-bold text-white' : inMonth ? 'text-slate-700' : 'text-slate-400',
                )}
              >
                {day.getDate()}
              </span>
              <div className="flex flex-col gap-0.5">
                {dayItems.slice(0, MAX_VISIBLE).map((it) => (
                  <EventChip key={it.kind + it.id} item={it} onSelect={() => onSelectItem(it)} compact />
                ))}
                {extra > 0 && (
                  <span className="px-1 text-[10px] font-medium text-slate-400">
                    עוד {extra}…
                  </span>
                )}
              </div>
            </button>
          );
        })}
      </div>
    </div>
  );
}

// ── Week view ────────────────────────────────────────────────────────────────
export function WeekView({ cursor, items, onSelectDay, onSelectItem }: ViewProps) {
  const days = weekDays(cursor);
  const byDate = groupByDate(items);
  const tKey = todayKey();

  return (
    <div className="overflow-hidden rounded-lg border border-slate-200 bg-white">
      <div className="grid grid-cols-7 divide-x divide-slate-100 [direction:rtl]">
        {days.map((day) => {
          const key = toDateKey(day);
          const dayItems = byDate.get(key) ?? [];
          const isToday = key === tKey;
          return (
            <div key={key} className="flex min-h-[420px] flex-col">
              <button
                type="button"
                onClick={() => onSelectDay(key)}
                className={cn(
                  'flex flex-col items-center gap-0.5 border-b border-slate-200 py-2 transition-colors hover:bg-slate-50',
                  isToday ? 'bg-blue-50' : 'bg-slate-50',
                )}
              >
                <span className="text-[11px] text-slate-500">
                  {HE_DAY_NAMES_SHORT[day.getDay()]}
                </span>
                <span
                  className={cn(
                    'inline-flex h-7 w-7 items-center justify-center rounded-full text-sm tabular-nums',
                    isToday ? 'bg-blue-600 font-bold text-white' : 'font-semibold text-slate-700',
                  )}
                >
                  {day.getDate()}
                </span>
              </button>
              <button
                type="button"
                onClick={() => onSelectDay(key)}
                className="flex flex-1 flex-col gap-1 p-1.5 text-start transition-colors hover:bg-slate-50/60"
              >
                {dayItems.length === 0 && <span className="sr-only">אין אירועים</span>}
                {dayItems.map((it) => (
                  <EventChip key={it.kind + it.id} item={it} onSelect={() => onSelectItem(it)} />
                ))}
              </button>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ── Day view ─────────────────────────────────────────────────────────────────
export function DayView({ cursor, items, onSelectDay, onSelectItem }: ViewProps) {
  const key = toDateKey(cursor);
  const dayItems = (groupByDate(items).get(key) ?? []).slice().sort((a, b) => {
    const ta = timeLabel(a) ?? '';
    const tb = timeLabel(b) ?? '';
    return ta.localeCompare(tb);
  });
  const isToday = key === todayKey();

  return (
    <div className="overflow-hidden rounded-lg border border-slate-200 bg-white">
      <div
        className={cn(
          'flex items-center justify-between gap-2 border-b border-slate-200 px-4 py-3',
          isToday ? 'bg-blue-50' : 'bg-slate-50',
        )}
      >
        <span className="text-base font-bold text-slate-800">
          {HE_DAY_NAMES[cursor.getDay()]}, {cursor.getDate()}
        </span>
        <span className="text-xs text-slate-400">{dayItems.length} פריטים</span>
      </div>
      <button
        type="button"
        onClick={() => onSelectDay(key)}
        className="flex w-full flex-col gap-2 p-4 text-start transition-colors hover:bg-slate-50/40"
      >
        {dayItems.length === 0 && (
          <span className="py-10 text-center text-sm text-slate-400">
            אין אירועים ביום זה. לחץ כדי להוסיף.
          </span>
        )}
        {dayItems.map((it) => (
          <div key={it.kind + it.id} className="flex items-stretch gap-2">
            <div className="w-16 shrink-0 pt-1 text-end">
              {timeLabel(it) ? (
                <span dir="ltr" className="inline-flex items-center gap-1 text-xs font-medium tabular-nums text-slate-500">
                  <Clock className="h-3 w-3" />{timeLabel(it)}
                </span>
              ) : (
                <span className="text-xs text-slate-400">כל היום</span>
              )}
            </div>
            <div className="flex-1">
              <EventChip item={it} onSelect={() => onSelectItem(it)} />
            </div>
          </div>
        ))}
      </button>
    </div>
  );
}
