'use client';

import { AlertTriangle, Bell, CheckSquare, MapPin, Repeat } from 'lucide-react';
import { cn } from '@/lib/utils';
import { HE_DAY_NAMES, HE_DAY_NAMES_SHORT, chipTone } from '@/lib/constants/calendar';
import {
  monthGridDays, weekDays, toDateKey, isSameMonth, todayKey,
} from '@/lib/calendar/dates';
import type { CalendarItem } from '@/lib/types/calendar';

export type CalendarView = 'month' | 'week' | 'day';

interface ViewProps {
  cursor: Date;
  items: CalendarItem[];
  onSelectDay: (dateKey: string) => void;
  onSelectItem: (item: CalendarItem) => void;
}

const pad = (n: number) => String(n).padStart(2, '0');

// Work-hours grid window (per decision): 08:00–20:00 inclusive (13 rows).
// Items outside the window are clamped to the nearest edge row (never hidden).
const HOURS: number[] = Array.from({ length: 13 }, (_, i) => 8 + i);
const FIRST_HOUR = HOURS[0];
const LAST_HOUR = HOURS[HOURS.length - 1];
const clampHour = (h: number) => Math.min(LAST_HOUR, Math.max(FIRST_HOUR, h));

// ── Time helpers ──────────────────────────────────────────────────────────────
function fmtTime(iso: string): string | null {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return d.toLocaleTimeString('he-IL', { hour: '2-digit', minute: '2-digit' });
}

/** Local start hour (0–23) of an item, or null when it is all-day / timeless. */
function startHour(item: CalendarItem): number | null {
  if (item.kind === 'event') {
    if (item.is_all_day || !item.start_datetime) return null;
    const d = new Date(item.start_datetime);
    return Number.isNaN(d.getTime()) ? null : d.getHours();
  }
  if (!item.due_time) return null;
  const h = parseInt(item.due_time.slice(0, 2), 10);
  return Number.isNaN(h) ? null : h;
}

/** Display time (a single time, or a start–end range for timed events). */
function timeText(item: CalendarItem): string | null {
  if (item.kind === 'event') {
    if (item.is_all_day || !item.start_datetime) return null;
    const s = fmtTime(item.start_datetime);
    const e = item.end_datetime ? fmtTime(item.end_datetime) : null;
    return e ? `${s}–${e}` : s;
  }
  return item.due_time;
}

const KIND_ICON: Record<string, typeof CheckSquare> = {
  task: CheckSquare,
  issue: AlertTriangle,
  reminder: Bell,
};

/** Group items by event_date, each day's list sorted (all-day first, then by time). */
function groupByDate(items: CalendarItem[]): Map<string, CalendarItem[]> {
  const m = new Map<string, CalendarItem[]>();
  for (const it of items) {
    const arr = m.get(it.event_date) ?? [];
    arr.push(it);
    m.set(it.event_date, arr);
  }
  for (const arr of m.values()) {
    arr.sort((a, b) => (startHour(a) ?? -1) - (startHour(b) ?? -1));
  }
  return m;
}

/** Split a single day's items into all-day + per-hour buckets (hours clamped). */
function splitDay(items: CalendarItem[]): { allDay: CalendarItem[]; perHour: Map<number, CalendarItem[]> } {
  const allDay: CalendarItem[] = [];
  const perHour = new Map<number, CalendarItem[]>();
  for (const it of items) {
    const h = startHour(it);
    if (h === null) {
      allDay.push(it);
    } else {
      const c = clampHour(h);
      const arr = perHour.get(c) ?? [];
      arr.push(it);
      perHour.set(c, arr);
    }
  }
  return { allDay, perHour };
}

// ── Shared item chip ──────────────────────────────────────────────────────────
// Four item types share ONE structure; they differ only by color + icon.
//  - 'dot'  (month): leading dot (event) / kind icon (overlay) + time + title
//  - 'bar'  (week/day): start-edge accent (3px) + title line + time line
function ItemChip({
  item, onSelect, variant,
}: { item: CalendarItem; onSelect: () => void; variant: 'dot' | 'bar' }) {
  const tone = chipTone(item.kind, item.kind === 'event' ? item.color_key : undefined);
  const t = timeText(item);
  const Icon = KIND_ICON[item.kind];
  const recurring = item.kind === 'event' ? item.recurrence_enabled : !!item.recurring;
  const cancelled = item.kind === 'event' && item.status === 'cancelled';
  const handle = (e: React.MouseEvent) => { e.stopPropagation(); onSelect(); };

  if (variant === 'dot') {
    return (
      <button
        type="button"
        onClick={handle}
        title={item.title}
        className={cn(
          'flex w-full items-center gap-1.5 truncate rounded-md px-1.5 py-1 text-start text-[11px] font-semibold transition-opacity hover:opacity-85',
          tone.bg, tone.text,
          cancelled && 'line-through opacity-60',
        )}
      >
        {Icon ? (
          <Icon className="h-3 w-3 shrink-0" />
        ) : (
          <span className={cn('h-1.5 w-1.5 shrink-0 rounded-full', tone.dot)} />
        )}
        {recurring && <Repeat className="h-2.5 w-2.5 shrink-0 opacity-70" />}
        {t && <span dir="ltr" className="shrink-0 tabular-nums text-[10px] opacity-80">{t}</span>}
        <span className="truncate">{item.title}</span>
      </button>
    );
  }

  return (
    <button
      type="button"
      onClick={handle}
      title={item.title}
      className={cn(
        'block w-full rounded-md border-s-[3px] px-2 py-1 text-start transition-opacity hover:opacity-85',
        tone.bg, tone.text, tone.edge,
        cancelled && 'line-through opacity-60',
      )}
    >
      <span className="flex items-center gap-1">
        {Icon && <Icon className="h-3 w-3 shrink-0" />}
        {recurring && <Repeat className="h-2.5 w-2.5 shrink-0 opacity-70" />}
        <span className="truncate text-[11.5px] font-bold leading-tight">{item.title}</span>
        {item.kind === 'event' && item.location && <MapPin className="h-2.5 w-2.5 shrink-0 opacity-60" />}
      </span>
      {t && (
        <span dir="ltr" className="mt-0.5 block text-end text-[10.5px] font-medium tabular-nums opacity-80">{t}</span>
      )}
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
    <div className="overflow-hidden rounded-[18px] border border-[#e9edf4] bg-white">
      {/* Day-of-week header (Sunday-first → Sunday on the right under RTL) */}
      <div className="grid grid-cols-7 border-b border-[#eef1f6] bg-[#fafbfd]">
        {HE_DAY_NAMES.map((name) => (
          <div key={name} className="py-3 text-center text-[13px] font-bold text-slate-500">
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
            <div
              key={key + idx}
              onClick={() => onSelectDay(key)}
              className={cn(
                'flex min-h-[116px] cursor-pointer flex-col gap-1 border-b border-l border-[#eef1f6] p-2 text-start transition-colors hover:bg-slate-50',
                '[&:nth-child(7n)]:border-l-0 [&:nth-child(n+36)]:border-b-0',
                !inMonth && 'bg-[#fafbfd]',
                isToday && 'bg-[#f5f9ff]',
              )}
            >
              <span
                className={cn(
                  'mb-0.5 inline-flex h-6 w-6 items-center justify-center self-end rounded-full text-[13px] tabular-nums',
                  isToday
                    ? 'bg-blue-600 font-bold text-white'
                    : inMonth ? 'font-semibold text-slate-900' : 'font-semibold text-slate-300',
                )}
              >
                {day.getDate()}
              </span>
              <div className="flex flex-col gap-1">
                {dayItems.slice(0, MAX_VISIBLE).map((it) => (
                  <ItemChip key={it.kind + it.id} item={it} onSelect={() => onSelectItem(it)} variant="dot" />
                ))}
                {extra > 0 && (
                  <span className="px-1 text-[10px] font-medium text-slate-400">עוד {extra}…</span>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ── Week view (hourly time grid, 08:00–20:00) ────────────────────────────────
export function WeekView({ cursor, items, onSelectDay, onSelectItem }: ViewProps) {
  const days = weekDays(cursor);
  const byDate = groupByDate(items);
  const tKey = todayKey();

  // Pre-split each day once.
  const perDay = days.map((day) => ({
    day,
    key: toDateKey(day),
    ...splitDay(byDate.get(toDateKey(day)) ?? []),
  }));
  const hasAllDay = perDay.some((d) => d.allDay.length > 0);

  return (
    <div className="overflow-hidden rounded-[18px] border border-[#e9edf4] bg-white">
      {/* Day header */}
      <div className="flex border-b border-[#eef1f6] bg-[#fafbfd] [direction:rtl]">
        <div className="w-[72px] shrink-0 border-l border-[#eef1f6]" />
        {days.map((day) => {
          const key = toDateKey(day);
          const isToday = key === tKey;
          return (
            <button
              key={key}
              type="button"
              onClick={() => onSelectDay(key)}
              className={cn(
                'flex flex-1 flex-col items-center gap-0.5 border-l border-[#eef1f6] py-2.5 transition-colors last:border-l-0 hover:bg-slate-50',
                isToday && 'bg-[#eef5ff]',
              )}
            >
              <span className={cn('text-[12.5px] font-semibold', isToday ? 'text-blue-600' : 'text-slate-400')}>
                {HE_DAY_NAMES_SHORT[day.getDay()]}
              </span>
              <span
                className={cn(
                  'inline-flex h-[26px] w-[26px] items-center justify-center rounded-full text-sm tabular-nums',
                  isToday ? 'bg-blue-600 font-bold text-white' : 'font-bold text-slate-900',
                )}
              >
                {day.getDate()}
              </span>
            </button>
          );
        })}
      </div>

      {/* All-day band (only when present) */}
      {hasAllDay && (
        <div className="flex border-b border-[#eef1f6] [direction:rtl]">
          <div className="flex w-[72px] shrink-0 items-center justify-center border-l border-[#eef1f6] py-1.5 text-[11px] font-bold text-slate-400">
            כל היום
          </div>
          {perDay.map(({ key, allDay }) => (
            <div
              key={key}
              onClick={() => onSelectDay(key)}
              className="flex flex-1 cursor-pointer flex-col gap-1 border-l border-[#f1f4f8] p-1 transition-colors last:border-l-0 hover:bg-slate-50/60"
            >
              {allDay.map((it) => (
                <ItemChip key={it.kind + it.id} item={it} onSelect={() => onSelectItem(it)} variant="bar" />
              ))}
            </div>
          ))}
        </div>
      )}

      {/* Hour rows */}
      {HOURS.map((h) => (
        <div key={h} className="flex border-b border-[#f1f4f8] last:border-b-0 [direction:rtl]">
          <div dir="ltr" className="w-[72px] shrink-0 border-l border-[#eef1f6] px-2.5 py-1.5 text-start text-[12px] font-semibold tabular-nums text-slate-400">
            {pad(h)}:00
          </div>
          {perDay.map(({ key, perHour }) => {
            const isToday = key === tKey;
            const cell = perHour.get(h) ?? [];
            return (
              <div
                key={key}
                onClick={() => onSelectDay(key)}
                className={cn(
                  'flex min-h-[58px] flex-1 cursor-pointer flex-col gap-1 border-l border-[#f1f4f8] p-1 transition-colors last:border-l-0 hover:bg-slate-50/60',
                  isToday && 'bg-[#eef5ff]/50',
                )}
              >
                {cell.map((it) => (
                  <ItemChip key={it.kind + it.id} item={it} onSelect={() => onSelectItem(it)} variant="bar" />
                ))}
              </div>
            );
          })}
        </div>
      ))}
    </div>
  );
}

// ── Day view (all-day row + hourly time grid, 08:00–20:00) ────────────────────
export function DayView({ cursor, items, onSelectDay, onSelectItem }: ViewProps) {
  const key = toDateKey(cursor);
  const { allDay, perHour } = splitDay(groupByDate(items).get(key) ?? []);

  return (
    <div className="overflow-hidden rounded-[18px] border border-[#e9edf4] bg-white">
      {/* All-day row */}
      <div className="flex border-b border-[#eef1f6] bg-[#fafbfd]">
        <div className="flex w-[84px] shrink-0 items-start border-l border-[#eef1f6] px-3.5 py-3 text-[12px] font-bold text-slate-400">
          יום שלם
        </div>
        <div
          onClick={() => onSelectDay(key)}
          className="flex flex-1 cursor-pointer flex-wrap gap-2 p-2.5 transition-colors hover:bg-slate-50/60"
        >
          {allDay.length === 0 ? (
            <span className="py-1 text-xs text-slate-300">—</span>
          ) : (
            allDay.map((it) => (
              <div key={it.kind + it.id} className="min-w-[180px] max-w-[240px]">
                <ItemChip item={it} onSelect={() => onSelectItem(it)} variant="bar" />
              </div>
            ))
          )}
        </div>
      </div>

      {/* Hour rows */}
      {HOURS.map((h) => {
        const cell = perHour.get(h) ?? [];
        return (
          <div key={h} className="flex border-b border-[#f1f4f8] last:border-b-0 transition-colors hover:bg-slate-50/50">
            <div dir="ltr" className="w-[84px] shrink-0 border-l border-[#eef1f6] px-3.5 py-2 text-start text-[12.5px] font-semibold tabular-nums text-slate-400">
              {pad(h)}:00
            </div>
            <div
              onClick={() => onSelectDay(key)}
              className="flex min-h-[60px] flex-1 cursor-pointer flex-col gap-1.5 p-2"
            >
              {cell.map((it) => (
                <ItemChip key={it.kind + it.id} item={it} onSelect={() => onSelectItem(it)} variant="bar" />
              ))}
            </div>
          </div>
        );
      })}
    </div>
  );
}
