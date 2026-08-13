'use client';

import { Repeat, CalendarClock } from 'lucide-react';
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from '@/components/ui/table';
import { CadenceStrip, CadenceProgress } from '@/components/recurrence/CadenceStrip';
import type { RecurringSeries } from '@/lib/db/tasks';

interface Props {
  series: RecurringSeries[];
  /** Open the series' template task (click anywhere on the row). */
  onSelect: (id: string) => void;
}

/** 'YYYY-MM-DD' → 'DD/MM/YYYY' (string-only, no Date/TZ pitfalls). */
function fmtDate(d: string): string {
  const [y, m, day] = d.split('-');
  return `${day}/${m}/${y}`;
}

/**
 * The "מחזוריות" tab body — one row per active recurring series, sorted by the
 * next occurrence (ascending; done server-side in listRecurringSeries). Each row
 * shows the title, the cadence strip (label + day/month chips) and the next
 * occurrence date + time. Click → opens the series task.
 */
export function RecurringSeriesList({ series, onSelect }: Props) {
  if (series.length === 0) {
    return (
      <div className="flex flex-col items-center gap-3 rounded-lg border bg-card p-12 text-center">
        <span className="grid h-12 w-12 place-items-center rounded-full bg-slate-100 text-slate-400">
          <Repeat className="h-6 w-6" />
        </span>
        <p className="text-sm text-muted-foreground">
          אין משימות מחזוריות עדיין. הפעל „חזרתיות” בעת יצירת משימה כדי שתופיע כאן.
        </p>
      </div>
    );
  }

  return (
    <>
      {/* מובייל (<md) — כרטיס לכל סדרה. עמודת "מחזוריות" מחזיקה
          `min-w-[220px]`, שבטלפון גורר גלילה אופקית של הטבלה כולה. */}
      <ul className="space-y-2 roomy:hidden">
        {series.map((s) => (
          <li key={s.id} className="relative rounded-xl border border-slate-200 bg-white p-3 shadow-soft-xs">
            <button
              type="button"
              onClick={() => onSelect(s.id)}
              aria-label={`פתיחת סדרה ${s.title}`}
              className="absolute inset-0 z-0 rounded-xl focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand"
            />
            <div className="pointer-events-none relative z-10">
              <div className="flex min-w-0 flex-wrap items-center gap-1.5">
                <Repeat className="h-3.5 w-3.5 shrink-0 text-blue-500" />
                <span className="min-w-0 flex-1 text-[14.5px] font-medium text-slate-900">{s.title}</span>
                <CadenceProgress
                  doneCount={s.done_count}
                  expectedCount={s.expected_count}
                  periodLabel={s.period_label}
                />
              </div>
              <div className="mt-2">
                <CadenceStrip label={s.label} chips={s.chips} />
              </div>
              <div className="mt-2 flex items-center gap-1.5 text-[12.5px] text-slate-600">
                <CalendarClock className="h-3.5 w-3.5 shrink-0 text-slate-400" />
                {s.next_occurrence
                  ? <span dir="ltr">{fmtDate(s.next_occurrence)}{s.due_time ? ` · ${s.due_time}` : ''}</span>
                  : <span className="text-slate-400">אין מופע קרוב</span>}
              </div>
            </div>
          </li>
        ))}
      </ul>

      <div className="hidden overflow-hidden rounded-lg border border-slate-200 bg-white roomy:block">
      <Table>
        <TableHeader className="[&_tr]:border-b [&_tr]:border-slate-200">
          <TableRow className="bg-slate-50 hover:bg-slate-50">
            <TableHead className="h-11 px-4 text-start text-sm font-semibold text-slate-500">כותרת</TableHead>
            <TableHead className="h-11 px-4 text-start text-sm font-semibold text-slate-500">מחזוריות</TableHead>
            <TableHead className="h-11 px-4 text-start text-sm font-semibold text-slate-500">המופע הבא</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {series.map((s) => (
            <TableRow
              key={s.id}
              onClick={() => onSelect(s.id)}
              className="h-12 cursor-pointer border-b border-slate-100 hover:bg-slate-50"
            >
              <TableCell className="px-4 py-3 text-start text-sm">
                <span className="flex items-center gap-1.5 font-medium text-slate-900">
                  <Repeat className="h-3.5 w-3.5 shrink-0 text-blue-500" />
                  {s.title}
                  <CadenceProgress
                    doneCount={s.done_count}
                    expectedCount={s.expected_count}
                    periodLabel={s.period_label}
                  />
                </span>
              </TableCell>
              <TableCell className="min-w-[220px] px-4 py-3 text-start text-sm">
                <CadenceStrip label={s.label} chips={s.chips} />
              </TableCell>
              <TableCell className="px-4 py-3 text-start text-sm">
                {s.next_occurrence ? (
                  <span className="inline-flex items-center gap-1.5 text-slate-700">
                    <CalendarClock className="h-3.5 w-3.5 shrink-0 text-slate-400" />
                    <span dir="ltr" className="tabular-nums">
                      {fmtDate(s.next_occurrence)}{s.due_time ? ` · ${s.due_time}` : ''}
                    </span>
                  </span>
                ) : (
                  <span className="text-xs text-slate-400">אין מופע קרוב</span>
                )}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
      </div>
    </>
  );
}
