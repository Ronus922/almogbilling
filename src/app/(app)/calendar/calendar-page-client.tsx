'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { ChevronRight, ChevronLeft, Plus, CalendarDays } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { HE_MONTH_NAMES } from '@/lib/constants/calendar';
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
  currentUserId: string;
}

const VIEW_LABEL: Record<CalendarView, string> = { month: 'חודש', week: 'שבוע', day: 'יום' };

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

export function CalendarPageClient({ canEdit, owners, currentUserId }: Props) {
  const router = useRouter();
  const searchParams = useSearchParams();

  const [view, setView] = useState<CalendarView>('month');
  const [cursor, setCursor] = useState<Date>(() => new Date());
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
    if (item.kind === 'task') {
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
      {/* Toolbar */}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex items-center gap-3">
          <h1 className="flex items-center gap-2 text-2xl font-extrabold text-slate-900">
            <CalendarDays className="h-6 w-6 text-blue-600" /> יומן
          </h1>
        </div>
        {canEdit && (
          <Button onClick={() => openCreate()} className="gap-2 bg-blue-600 text-white hover:bg-blue-700">
            <Plus className="h-4 w-4" /> אירוע חדש
          </Button>
        )}
      </div>

      <div className="flex flex-col gap-3 rounded-lg border border-slate-200 bg-white p-3 sm:flex-row sm:items-center sm:justify-between">
        {/* Navigation (RTL: previous = right chevron) */}
        <div className="flex items-center gap-2">
          <Button variant="outline" size="sm" onClick={goToday} className="h-9">היום</Button>
          <div className="flex items-center">
            <Button variant="outline" size="icon" onClick={() => navigate(-1)} aria-label="הקודם" className="h-9 w-9 rounded-e-none">
              <ChevronRight className="h-4 w-4" />
            </Button>
            <Button variant="outline" size="icon" onClick={() => navigate(1)} aria-label="הבא" className="h-9 w-9 rounded-s-none border-s-0">
              <ChevronLeft className="h-4 w-4" />
            </Button>
          </div>
          <span className="text-lg font-bold text-slate-800">{title}</span>
        </div>

        {/* View toggle */}
        <div className="inline-flex rounded-lg border border-slate-200 bg-slate-50 p-0.5">
          {(['month', 'week', 'day'] as CalendarView[]).map((v) => (
            <button
              key={v} type="button" onClick={() => setView(v)}
              className={cn(
                'cursor-pointer rounded-md px-4 py-1.5 text-sm font-medium transition-colors',
                view === v ? 'bg-white text-blue-700 shadow-sm' : 'text-slate-500 hover:text-slate-700',
              )}
            >
              {VIEW_LABEL[v]}
            </button>
          ))}
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

      {/* Legend */}
      <div className="flex flex-wrap items-center gap-4 text-xs text-slate-500">
        <span className="inline-flex items-center gap-1.5">
          <span className="inline-block h-3 w-3 rounded border border-blue-300 bg-blue-100" /> אירוע
        </span>
        <span className="inline-flex items-center gap-1.5">
          <span className="inline-block h-3 w-3 rounded border border-dashed border-slate-300 bg-slate-50" /> משימה (תאריך יעד)
        </span>
      </div>

      <EventFormPanel
        open={panelOpen}
        eventId={editingId}
        presetDate={presetDate}
        canEdit={canEdit}
        owners={owners}
        currentUserId={currentUserId}
        onOpenChange={handlePanelChange}
        onSaved={fetchItems}
      />
    </main>
  );
}
