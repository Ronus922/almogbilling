'use client';

import { useTransition } from 'react';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { cn } from '@/lib/utils';
import { currentMonthKey, monthLabel, shiftMonthKey } from '@/lib/finance/period';

/** Month cursor of the overview (DESIGN.md §35): prev / next chevrons around
 *  the month name + "החודש". Writes ?m=YYYY-MM to the URL so the server
 *  re-renders the month (same mechanism as OverviewControls). */
export function MonthPicker({ month }: { month: string }) {
  const router = useRouter();
  const pathname = usePathname();
  const sp = useSearchParams();
  const [pending, startTransition] = useTransition();

  const go = (m: string) => {
    const q = new URLSearchParams(sp.toString());
    q.set('m', m);
    startTransition(() => router.push(`${pathname}?${q.toString()}`));
  };
  const isCurrent = month === currentMonthKey();

  const btn = 'flex h-[38px] w-[38px] items-center justify-center rounded-[10px] border border-[#e2e8f0] bg-white text-[#475569] transition-colors hover:bg-slate-50 disabled:opacity-60';
  return (
    <div className={cn('flex items-center gap-2', pending && 'opacity-70')}>
      {/* RTL: "previous" is on the right (ChevronRight), "next" on the left. */}
      <button type="button" onClick={() => go(shiftMonthKey(month, -1))} disabled={pending} aria-label="חודש קודם" className={btn}>
        <ChevronRight className="h-4 w-4" />
      </button>
      <h2 className="min-w-[128px] text-center text-[19px] font-extrabold text-[#0f172a]">{monthLabel(month)}</h2>
      <button type="button" onClick={() => go(shiftMonthKey(month, 1))} disabled={pending} aria-label="חודש הבא" className={btn}>
        <ChevronLeft className="h-4 w-4" />
      </button>
      <button
        type="button"
        onClick={() => go(currentMonthKey())}
        disabled={pending || isCurrent}
        className="h-[38px] rounded-[10px] border border-[#e2e8f0] bg-white px-[18px] text-sm font-semibold text-[#334155] transition-colors hover:bg-slate-50 disabled:opacity-60"
      >
        החודש
      </button>
    </div>
  );
}
