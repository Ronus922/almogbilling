'use client';

import { Fragment, useState, useTransition } from 'react';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { CalendarDays, ChevronDown, ChevronLeft, ChevronRight, X } from 'lucide-react';
import { Sheet, SheetContent, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { useEscapeKey } from '@/lib/hooks/useEscapeKey';
import { useMediaQuery } from '@/lib/hooks/useMediaQuery';
import { cn } from '@/lib/utils';
import { HE_MONTH_NAMES } from '@/lib/constants/calendar';
import { HALF_LABEL, currentMonthKey, makePeriod, periodLabel, type Period } from '@/lib/finance/period';

// The period picker of the operating overview (DESIGN.md §35): one trigger
// showing the selection; a panel with « כל YYYY » (year arrows, the title
// selects the year) over a 3×4 month grid where each row is a quarter with a
// clickable "רבעון N" label and each pair of rows a vertical "מחצית" label.
// Every click selects AND closes — no range mode, no second click. Published
// months carry a green dot; future months are grey and inert. Desktop: an
// anchored panel; phones: a bottom sheet — the same grid in both.

const DESKTOP = '(min-width: 768px)';

function pad(n: number): string {
  return String(n).padStart(2, '0');
}

function PeriodGrid({ year, onYear, selected, published, onPick }: {
  year: number;
  onYear: (y: number) => void;
  selected: Period;
  published: ReadonlySet<string>;
  onPick: (p: Period) => void;
}) {
  const current = currentMonthKey();
  const future = (monthKey: string) => monthKey > current;
  const yearFuture = future(`${year}-01`);
  const inSelection = (monthKey: string) => selected.kind !== 'month' && monthKey >= selected.from && monthKey <= selected.to;

  const label = (active: boolean, disabled: boolean) => cn(
    'flex min-h-11 items-center justify-center rounded-lg text-xs font-semibold transition-colors',
    disabled
      ? 'cursor-not-allowed border border-transparent text-slate-300'
      : active
        ? 'bg-blue-600 text-white shadow-soft-sm'
        : 'cursor-pointer border border-line bg-white text-ink-2 hover:bg-slate-50',
  );

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2">
        {/* RTL: the previous year sits on the right (ChevronRight), the next on the left. */}
        <button type="button" onClick={() => onYear(year - 1)} aria-label="שנה קודמת" className="flex h-11 w-11 shrink-0 items-center justify-center rounded-[10px] border border-line bg-white text-ink-2 hover:bg-slate-50">
          <ChevronRight className="h-4 w-4" />
        </button>
        <button
          type="button"
          onClick={() => onPick(makePeriod('year', year, 1))}
          disabled={yearFuture}
          aria-label={`בחר את כל ${year}`}
          className={cn(
            'h-11 flex-1 rounded-[10px] text-[17px] font-extrabold transition-colors',
            yearFuture
              ? 'cursor-not-allowed text-slate-300'
              : selected.kind === 'year' && selected.year === year
                ? 'bg-blue-600 text-white shadow-soft-sm'
                : 'cursor-pointer text-[#0f172a] hover:bg-slate-50',
          )}
        >
          כל {year}
        </button>
        <button type="button" onClick={() => onYear(year + 1)} aria-label="שנה הבאה" className="flex h-11 w-11 shrink-0 items-center justify-center rounded-[10px] border border-line bg-white text-ink-2 hover:bg-slate-50">
          <ChevronLeft className="h-4 w-4" />
        </button>
      </div>

      <div className="grid gap-1.5" style={{ gridTemplateColumns: '2.75rem 4.5rem repeat(3, minmax(0, 1fr))', gridAutoRows: '2.75rem' }}>
        {[1, 2, 3, 4].map((q) => {
          const half = q <= 2 ? 1 : 2;
          const quarterFrom = `${year}-${pad((q - 1) * 3 + 1)}`;
          const halfFrom = `${year}-${pad((half - 1) * 6 + 1)}`;
          const quarterActive = selected.kind === 'quarter' && selected.year === year && selected.index === q;
          const halfActive = selected.kind === 'half' && selected.year === year && selected.index === half;
          return (
            <Fragment key={q}>
              {q % 2 === 1 && (
                <button
                  type="button"
                  onClick={() => onPick(makePeriod('half', year, half))}
                  disabled={future(halfFrom)}
                  aria-label={`בחר ${HALF_LABEL[half]} ${year}`}
                  className={cn(label(halfActive, future(halfFrom)), 'row-span-2')}
                >
                  <span className="[writing-mode:vertical-rl] rotate-180">{HALF_LABEL[half]}</span>
                </button>
              )}
              <button
                type="button"
                onClick={() => onPick(makePeriod('quarter', year, q))}
                disabled={future(quarterFrom)}
                aria-label={`בחר רבעון ${q} ${year}`}
                className={label(quarterActive, future(quarterFrom))}
              >
                רבעון {q}
              </button>
              {[0, 1, 2].map((i) => {
                const m = (q - 1) * 3 + i + 1;
                const key = `${year}-${pad(m)}`;
                const disabled = future(key);
                const active = selected.kind === 'month' && selected.key === key;
                return (
                  <button
                    key={key}
                    type="button"
                    onClick={() => onPick(makePeriod('month', year, m))}
                    disabled={disabled}
                    aria-label={`בחר ${HE_MONTH_NAMES[m - 1]} ${year}`}
                    aria-pressed={active}
                    className={cn(
                      'relative flex min-h-11 items-center justify-center rounded-lg px-1 text-[13px] font-semibold transition-colors',
                      disabled
                        ? 'cursor-not-allowed border border-transparent text-slate-300'
                        : active
                          ? 'bg-blue-600 text-white shadow-soft-sm'
                          : inSelection(key)
                            ? 'cursor-pointer border border-blue-200 bg-blue-50 text-blue-700 hover:bg-blue-100'
                            : 'cursor-pointer border border-line bg-white text-ink hover:bg-slate-50',
                      key === current && !active && 'ring-1 ring-inset ring-blue-300',
                    )}
                  >
                    {HE_MONTH_NAMES[m - 1]}
                    {published.has(key) && (
                      <span aria-label="פורסם לדיירים" className={cn('absolute end-1.5 top-1.5 h-1.5 w-1.5 rounded-full', active ? 'bg-white' : 'bg-emerald-500')} />
                    )}
                  </button>
                );
              })}
            </Fragment>
          );
        })}
      </div>

      <p className="flex items-center gap-1.5 text-[11px] text-ink-3">
        <span className="h-1.5 w-1.5 rounded-full bg-emerald-500" aria-hidden /> חודש שמוצג לדיירים
      </p>
    </div>
  );
}

export function PeriodPicker({ period, publishedMonths }: {
  period: Period;
  /** 'YYYY-MM' keys of the published months (green dots). */
  publishedMonths: string[];
}) {
  const router = useRouter();
  const pathname = usePathname();
  const sp = useSearchParams();
  const [pending, startTransition] = useTransition();
  const [open, setOpen] = useState(false);
  const [year, setYear] = useState(period.year);
  const isDesktop = useMediaQuery(DESKTOP);
  const published = new Set(publishedMonths);

  useEscapeKey(open && isDesktop, () => setOpen(false));

  function toggle() {
    if (!open) setYear(period.year);
    setOpen((o) => !o);
  }

  function pick(p: Period) {
    setOpen(false);
    if (p.key === period.key) return;
    const q = new URLSearchParams(sp.toString());
    q.set('m', p.key);
    startTransition(() => router.push(`${pathname}?${q.toString()}`));
  }

  const trigger = (
    <button
      type="button"
      onClick={toggle}
      aria-haspopup="dialog"
      aria-expanded={open}
      className={cn(
        'flex h-[38px] items-center gap-2 rounded-[10px] border border-[#e2e8f0] bg-white px-3 text-[#0f172a] transition-colors hover:bg-slate-50',
        pending && 'opacity-70',
      )}
    >
      <CalendarDays className="h-4 w-4 text-[#475569]" aria-hidden />
      <span className="min-w-[128px] text-center text-[17px] font-extrabold">{periodLabel(period)}</span>
      <ChevronDown className={cn('h-4 w-4 text-[#475569] transition-transform', open && 'rotate-180')} aria-hidden />
    </button>
  );

  const grid = <PeriodGrid year={year} onYear={setYear} selected={period} published={published} onPick={pick} />;

  if (isDesktop) {
    return (
      <div className="relative">
        {trigger}
        {open && (
          <>
            <div className="fixed inset-0 z-40" onClick={() => setOpen(false)} aria-hidden />
            <div role="dialog" aria-label="בחירת תקופה" className="absolute start-0 top-full z-50 mt-2 w-[400px] rounded-xl border border-line bg-white p-4 shadow-soft-md">
              {grid}
            </div>
          </>
        )}
      </div>
    );
  }

  return (
    <>
      {trigger}
      <Sheet open={open} onOpenChange={setOpen}>
        <SheetContent side="bottom" dir="rtl" showCloseButton={false} className="rounded-t-2xl bg-white p-4 pb-[max(1rem,env(safe-area-inset-bottom))]">
          <SheetHeader className="flex-row items-center justify-between p-0 pb-2 text-start">
            <SheetTitle className="text-lg font-bold text-slate-900">בחירת תקופה</SheetTitle>
            {/* Own 44px close (the default sheet X is smaller than a touch target). */}
            <button type="button" onClick={() => setOpen(false)} aria-label="סגור" className="grid h-11 w-11 place-items-center rounded-lg text-slate-500 hover:bg-slate-100">
              <X className="h-5 w-5" />
            </button>
          </SheetHeader>
          {grid}
        </SheetContent>
      </Sheet>
    </>
  );
}
