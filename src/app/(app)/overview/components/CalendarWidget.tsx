import Link from 'next/link';
import { CalendarDays, ChevronRight, ChevronLeft } from 'lucide-react';
import { cn } from '@/lib/utils';
import { EmptyState } from './OverviewCard';
import { monthYearLabel } from '../format';
import { KIND_DOT, KIND_LEGEND } from '../meta';
import type { CalendarMonthData, Period } from '../data';

const WEEKDAYS = ['א', 'ב', 'ג', 'ד', 'ה', 'ו', 'ש'];

export function CalendarWidget({ data, period }: { data: CalendarMonthData | null; period: Period }) {
  // Leading blanks (weekday of the 1st) + the month's days, padded to full weeks.
  const cells: (number | null)[] = data
    ? [
        ...Array.from({ length: data.firstWeekday }, () => null),
        ...Array.from({ length: data.daysInMonth }, (_, i) => i + 1),
      ]
    : [];
  while (cells.length % 7 !== 0) cells.push(null);

  return (
    <section className="overflow-hidden rounded-2xl border border-line bg-white shadow-soft-xs">
      <div className="flex items-center justify-between gap-3 px-4 py-3">
        <div className="flex items-center gap-2.5">
          <span className="grid h-9 w-9 shrink-0 place-items-center rounded-[10px] bg-blue-50 text-blue-600" aria-hidden>
            <CalendarDays className="h-[18px] w-[18px]" />
          </span>
          <h3 className="text-base font-bold text-ink">לוח שנה</h3>
        </div>
        {data && (
          <div className="flex items-center gap-2">
            {/* RTL: previous month sits on the right, next on the left. */}
            <Link
              href={`/overview?period=${period}&cal=${data.prevYm}`}
              aria-label="חודש קודם"
              className="grid h-[38px] w-[38px] place-items-center rounded-[10px] border border-line text-ink-2 transition-colors hover:bg-row-hover"
            >
              <ChevronRight className="h-4 w-4" />
            </Link>
            <span className="min-w-[74px] text-center text-[13px] font-bold text-ink">{monthYearLabel(data.ym)}</span>
            <Link
              href={`/overview?period=${period}&cal=${data.nextYm}`}
              aria-label="חודש הבא"
              className="grid h-[38px] w-[38px] place-items-center rounded-[10px] border border-line text-ink-2 transition-colors hover:bg-row-hover"
            >
              <ChevronLeft className="h-4 w-4" />
            </Link>
          </div>
        )}
      </div>

      {!data ? (
        <EmptyState message="לא ניתן לטעון את לוח השנה" />
      ) : (
        <div className="px-4 pb-4">
          <div className="mb-1.5 grid grid-cols-7 gap-0.5">
            {WEEKDAYS.map((d) => (
              <span key={d} className="py-1 text-center text-[11px] font-bold text-ink-3">{d}</span>
            ))}
          </div>
          <div className="grid grid-cols-7 gap-1">
            {cells.map((day, idx) => {
              if (day === null) return <span key={idx} />;
              const kinds = data.kindsByDay[day] ?? [];
              const isToday = data.todayDay === day;
              return (
                <div
                  key={idx}
                  className={cn(
                    'flex h-[42px] flex-col items-center justify-center rounded-[9px] text-[13px] font-semibold',
                    isToday ? 'bg-brand font-extrabold text-white shadow-soft-sm' : 'text-ink',
                  )}
                >
                  {day}
                  {kinds.length > 0 && (
                    <span className="mt-0.5 flex h-[5px] items-center gap-[2px]">
                      {kinds.map((k) => (
                        <span
                          key={k}
                          className="h-[5px] w-[5px] rounded-full"
                          style={{ background: isToday ? '#ffffff' : KIND_DOT[k] }}
                        />
                      ))}
                    </span>
                  )}
                </div>
              );
            })}
          </div>
          <div className="mt-3 flex flex-wrap items-center gap-x-3.5 gap-y-1.5 border-t border-line/70 pt-3">
            {KIND_LEGEND.map((l) => (
              <span key={l.kind} className="inline-flex items-center gap-1.5 text-[11.5px] font-medium text-ink-2">
                <span className="h-[7px] w-[7px] rounded-full" style={{ background: KIND_DOT[l.kind] }} />
                {l.label}
              </span>
            ))}
          </div>
        </div>
      )}
    </section>
  );
}
