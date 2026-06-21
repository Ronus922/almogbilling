'use client';

import { useTransition } from 'react';
import { useRouter, usePathname, useSearchParams } from 'next/navigation';
import { RefreshCw } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { Period } from '../data';

const OPTIONS: { value: Period; label: string }[] = [
  { value: 'month', label: 'חודש' },
  { value: 'quarter', label: 'רבעון' },
  { value: 'year', label: 'שנה' },
];

/** Period segmented control + refresh. Period writes ?period to the URL (the
 *  server re-renders the chart for the new window); refresh re-runs the server
 *  render. Calendar month is preserved across period changes. */
export function OverviewControls({ period }: { period: Period }) {
  const router = useRouter();
  const pathname = usePathname();
  const sp = useSearchParams();
  const [pending, startTransition] = useTransition();

  const setPeriod = (p: Period) => {
    const q = new URLSearchParams(sp.toString());
    q.set('period', p);
    startTransition(() => router.push(`${pathname}?${q.toString()}`));
  };
  const refresh = () => startTransition(() => router.refresh());

  return (
    <div className="flex items-center gap-2.5">
      <div className="flex items-center gap-1 rounded-xl border border-line bg-white p-1">
        {OPTIONS.map((o) => (
          <button
            key={o.value}
            type="button"
            onClick={() => setPeriod(o.value)}
            disabled={pending}
            aria-pressed={period === o.value}
            className={cn(
              'h-9 rounded-lg px-3.5 text-[13px] font-semibold transition-colors disabled:opacity-60',
              period === o.value ? 'bg-brand text-white' : 'text-ink-2 hover:bg-row-hover',
            )}
          >
            {o.label}
          </button>
        ))}
      </div>
      <button
        type="button"
        onClick={refresh}
        disabled={pending}
        className="flex h-11 items-center gap-2 rounded-xl border border-line bg-white px-4 text-[13px] font-semibold text-ink-2 transition-colors hover:bg-row-hover disabled:opacity-60"
      >
        <RefreshCw className={cn('h-4 w-4', pending && 'animate-spin')} aria-hidden />
        רענון
      </button>
    </div>
  );
}
