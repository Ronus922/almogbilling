'use client';

import { Repeat, CalendarClock } from 'lucide-react';
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from '@/components/ui/table';
import { summarizeCadence } from '@/lib/constants/recurrence';
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
 * shows the title, the cadence (כל יום/שבוע/חודש…) and the next occurrence
 * date + time. Click → opens the series' template task.
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
    <div className="overflow-hidden rounded-lg border border-slate-200 bg-white">
      <Table>
        <TableHeader className="[&_tr]:border-b [&_tr]:border-slate-200">
          <TableRow className="bg-slate-50 hover:bg-slate-50">
            <TableHead className="h-11 px-4 text-right text-sm font-semibold text-slate-500">כותרת</TableHead>
            <TableHead className="h-11 px-4 text-right text-sm font-semibold text-slate-500">מחזוריות</TableHead>
            <TableHead className="h-11 px-4 text-right text-sm font-semibold text-slate-500">המופע הבא</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {series.map((s) => (
            <TableRow
              key={s.id}
              onClick={() => onSelect(s.id)}
              className="h-12 cursor-pointer border-b border-slate-100 hover:bg-slate-50"
            >
              <TableCell className="px-4 py-3 text-right text-sm">
                <span className="flex items-center gap-1.5 font-medium text-slate-900">
                  <Repeat className="h-3.5 w-3.5 shrink-0 text-slate-400" />
                  {s.title}
                </span>
              </TableCell>
              <TableCell className="px-4 py-3 text-right text-sm">
                <span className="inline-flex items-center rounded-full bg-slate-100 px-2.5 py-0.5 text-xs font-medium text-slate-600">
                  {summarizeCadence(s.frequency, s.interval, s.byweekday)}
                </span>
              </TableCell>
              <TableCell className="px-4 py-3 text-right text-sm">
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
  );
}
