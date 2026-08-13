'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { ChevronRight, ChevronLeft, Plus, CalendarDays } from 'lucide-react';
import { cn } from '@/lib/utils';
import { todayInJerusalem } from '@/lib/dates';
import { HE_MONTH_NAMES, chipTone, ITEM_KIND_LABEL } from '@/lib/constants/calendar';
import {
  monthGridDays, weekDays, toDateKey, addDays, addMonths, startOfWeek,
} from '@/lib/calendar/dates';
import { MonthView, WeekView, DayView, type CalendarView } from '@/components/calendar/calendar-views';
import { EventFormPanel } from '@/components/calendar/event-form-panel';
import type { CalendarItem } from '@/lib/types/calendar';

interface Owner { id: string; name: string }

interface Props {
  canEdit: boolean;
  owners: Owner[];
  currentUserName: string;
}

// Segmented control order (RTL → first DOM child sits rightmost): יום · שבוע · חודש.
const VIEWS: { value: CalendarView; label: string }[] = [
  { value: 'day', label: 'יום' },
  { value: 'week', label: 'שבוע' },
  { value: 'month', label: 'חודש' },
];

// Legend kinds — color-only distinction between the four item types.
const LEGEND_KINDS = ['event', 'task', 'issue', 'reminder'] as const;

/** Compute the inclusive [from,to] date range a given view+cursor needs. */
function rangeFor(view: CalendarView, cursor: Date): { from: string; to: string } {
  if (view === 'month') {
    const days = monthGridDays(cursor);
    return { from: toDateKey(days[0]), to: toDateKey(days[days.length - 1]) };
  }
  if (view === 'week') {
    const days = weekDays(cursor);
    return { from: toDateKey(days[0]), to: toDateKey(days[days.length - 1]) };
  }
  return { from: toDateKey(cursor), to: toDateKey(cursor) };
}

export function CalendarPageClient({ canEdit, owners, currentUserName }: Props) {
  const router = useRouter();
  const searchParams = useSearchParams();

  // Month is the desktop default. On a phone a 7-column month grid gives each
  // day ~45px — too narrow to read an event chip, let alone tap one — so the
  // calendar opens on the day view instead. Resolved once, after mount, so the
  // server-rendered markup (always 'month') matches the first client render and
  // hydration does not mismatch; the view switcher stays fully available.
  const [view, setView] = useState<CalendarView>('month');
  useEffect(() => {
    if (window.matchMedia('(max-width: 639.98px)').matches) setView('day');
  }, []);
  // Anchor the initial cursor to Jerusalem's "today" at local noon so the month/
  // day labels (getMonth/getDate/getFullYear) read identically on the UTC server
  // and the Jerusalem browser — noon is far from any day boundary (no #418).
  const [cursor, setCursor] = useState<Date>(() => new Date(`${todayInJerusalem()}T12:00:00`));
  const [items, setItems] = useState<CalendarItem[]>([]);
  const [loading, setLoading] = useState(true);

  const [panelOpen, setPanelOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [presetDate, setPresetDate] = useState<string | null>(null);

  const range = useMemo(() => rangeFor(view, cursor), [view, cursor]);

  const fetchItems = useCallback(async () => {
    setLoading(true);
    try {
      const r = await fetch(`/api/calendar?from=${range.from}&to=${range.to}`, { credentials: 'include' });
      if (r.ok) {
        const data = (await r.json()) as { items: CalendarItem[] };
        setItems(Array.isArray(data.items) ? data.items : []);
      } else {
        setItems([]);
      }
    } catch {
      setItems([]);
    } finally {
      setLoading(false);
    }
  }, [range.from, range.to]);

  useEffect(() => { void fetchItems(); }, [fetchItems]);

  // Deep link: ?event=<id> opens the panel in edit mode.
  useEffect(() => {
    const id = searchParams.get('event');
    if (id) {
      setEditingId(id);
      setPresetDate(null);
      setPanelOpen(true);
    }
  }, [searchParams]);

  function navigate(dir: -1 | 1) {
    setCursor((prev) => {
      if (view === 'month') return addMonths(prev, dir);
      if (view === 'week') return addDays(startOfWeek(prev), dir * 7);
      return addDays(prev, dir);
    });
  }
  function goToday() { setCursor(new Date()); }

  function openCreate(dateKey?: string) {
    if (!canEdit) return;
    setEditingId(null);
    setPresetDate(dateKey ?? toDateKey(cursor));
    setPanelOpen(true);
  }
  function openItem(item: CalendarItem) {
    // Only manual events open the calendar panel; task/issue/reminder overlays
    // deep-link back to their own module card.
    if (item.kind !== 'event') {
      router.push(item.action_url);
      return;
    }
    setEditingId(item.id);
    setPresetDate(null);
    setPanelOpen(true);
  }

  // Title label per view.
  const title = useMemo(() => {
    if (view === 'month') return `${HE_MONTH_NAMES[cursor.getMonth()]} ${cursor.getFullYear()}`;
    if (view === 'week') {
      const days = weekDays(cursor);
      const a = days[0]; const b = days[6];
      const sameMonth = a.getMonth() === b.getMonth();
      return sameMonth
        ? `${a.getDate()}–${b.getDate()} ${HE_MONTH_NAMES[a.getMonth()]} ${a.getFullYear()}`
        : `${a.getDate()} ${HE_MONTH_NAMES[a.getMonth()]} – ${b.getDate()} ${HE_MONTH_NAMES[b.getMonth()]}`;
    }
    return `${cursor.getDate()} ${HE_MONTH_NAMES[cursor.getMonth()]} ${cursor.getFullYear()}`;
  }, [view, cursor]);

  const ViewComp = view === 'month' ? MonthView : view === 'week' ? WeekView : DayView;

  function handlePanelChange(o: boolean) {
    setPanelOpen(o);
    if (!o) {
      setEditingId(null);
      setPresetDate(null);
      // Clear the ?event= param so re-opening the same event re-triggers.
      if (searchParams.get('event')) router.replace('/calendar');
    }
  }

  return (
    <main className="flex flex-col gap-4">
      {/* Top bar — icon tile + title (right) · gradient CTA (left) */}
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <span className="flex h-11 w-11 items-center justify-center rounded-[13px] bg-[#e8f0ff] text-[#2563eb]">
            <CalendarDays className="h-6 w-6" />
          </span>
          <h1 className="text-[27px] font-black leading-none tracking-tight text-[#0f172a]">יומן</h1>
        </div>
        {canEdit && (
          <button
            type="button"
            onClick={() => openCreate()}
            className="inline-flex h-[46px] items-center gap-2 rounded-[13px] bg-gradient-to-l from-[#1d4ed8] to-[#2563eb] px-5 text-[14.5px] font-bold text-white shadow-[0_10px_22px_-8px_rgba(37,99,235,0.6)] transition-opacity hover:opacity-95"
          >
            <Plus className="h-4 w-4" /> אירוע חדש
          </button>
        )}
      </div>

      {/* Toolbar — segmented control (right) · period title + today + nav (left) */}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="inline-flex rounded-[12px] border border-[#e9edf4] bg-white p-1">
          {VIEWS.map((v) => (
            <button
              key={v.value}
              type="button"
              onClick={() => setView(v.value)}
              className={cn(
                'h-9 cursor-pointer rounded-lg px-[18px] text-sm transition-colors',
                view === v.value
                  ? 'bg-[#2563eb] font-bold text-white'
                  : 'font-semibold text-[#475569] hover:bg-slate-50',
              )}
            >
              {v.label}
            </button>
          ))}
        </div>

        <div className="flex items-center gap-3">
          <h2 className="min-w-[110px] text-center text-[19px] font-extrabold text-[#0f172a]">{title}</h2>
          <button
            type="button"
            onClick={goToday}
            className="h-[38px] rounded-[10px] border border-[#e2e8f0] bg-white px-[18px] text-sm font-semibold text-[#334155] transition-colors hover:bg-slate-50"
          >
            היום
          </button>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => navigate(-1)}
              aria-label="הקודם"
              className="flex h-[38px] w-[38px] items-center justify-center rounded-[10px] border border-[#e2e8f0] bg-white text-[#475569] transition-colors hover:bg-slate-50"
            >
              <ChevronRight className="h-4 w-4" />
            </button>
            <button
              type="button"
              onClick={() => navigate(1)}
              aria-label="הבא"
              className="flex h-[38px] w-[38px] items-center justify-center rounded-[10px] border border-[#e2e8f0] bg-white text-[#475569] transition-colors hover:bg-slate-50"
            >
              <ChevronLeft className="h-4 w-4" />
            </button>
          </div>
        </div>
      </div>

      {/* Grid */}
      <div className={cn('relative', loading && 'opacity-60')}>
        <ViewComp cursor={cursor} items={items} onSelectDay={openCreate} onSelectItem={openItem} />
        {loading && (
          <div className="pointer-events-none absolute inset-0 grid place-items-center">
            <span className="rounded-full bg-white px-3 py-1 text-xs text-slate-400 shadow-sm">טוען…</span>
          </div>
        )}
      </div>

      {/* Legend — four item types, distinguished by color */}
      <div className="flex flex-wrap items-center gap-4 text-[12.5px] font-medium text-slate-500">
        {LEGEND_KINDS.map((kind) => {
          const tone = chipTone(kind, 'blue');
          return (
            <span key={kind} className="inline-flex items-center gap-1.5">
              <span className={cn('inline-flex h-3.5 w-3.5 items-center justify-center rounded', tone.bg)}>
                <span className={cn('h-1.5 w-1.5 rounded-full', tone.dot)} />
              </span>
              {ITEM_KIND_LABEL[kind]}
            </span>
          );
        })}
      </div>

      <EventFormPanel
        open={panelOpen}
        eventId={editingId}
        presetDate={presetDate}
        canEdit={canEdit}
        owners={owners}
        currentUserName={currentUserName}
        onOpenChange={handlePanelChange}
        onSaved={fetchItems}
      />
    </main>
  );
}
