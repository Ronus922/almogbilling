'use client';

import { useTransition } from 'react';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { PiggyBank, Wallet } from 'lucide-react';
import { cn } from '@/lib/utils';

export type FinanceTab = 'operating' | 'fund';

// The two tabs of /finance (DESIGN.md §16 pattern, without counters): the
// operating budget (default, no `tab` param) and the renovation fund
// (`?tab=fund`). Switching keeps the period (`m`) so coming back restores it.
export function FinanceTabs({ active }: { active: FinanceTab }) {
  const router = useRouter();
  const pathname = usePathname();
  const sp = useSearchParams();
  const [pending, startTransition] = useTransition();

  function go(tab: FinanceTab) {
    if (tab === active) return;
    const q = new URLSearchParams(sp.toString());
    if (tab === 'operating') q.delete('tab'); else q.set('tab', tab);
    const qs = q.toString();
    startTransition(() => router.push(qs ? `${pathname}?${qs}` : pathname));
  }

  const tabs: Array<{ key: FinanceTab; label: string; icon: typeof Wallet; activeBg: string }> = [
    { key: 'operating', label: 'שוטף', icon: Wallet, activeBg: 'bg-blue-600' },
    { key: 'fund', label: 'קרן שיפוצים', icon: PiggyBank, activeBg: 'bg-violet-600' },
  ];

  return (
    <div role="tablist" aria-label="חלקי השקיפות הכספית" className={cn('grid grid-cols-2 gap-2 sm:max-w-sm', pending && 'opacity-70')}>
      {tabs.map((t) => {
        const isActive = t.key === active;
        const Icon = t.icon;
        return (
          <button
            key={t.key}
            type="button"
            role="tab"
            aria-selected={isActive}
            onClick={() => go(t.key)}
            className={cn(
              'inline-flex h-11 w-full cursor-pointer items-center justify-center gap-2 whitespace-nowrap rounded-xl px-4 text-sm font-semibold leading-none transition-colors',
              isActive ? `${t.activeBg} text-white shadow-soft-sm` : 'border border-line bg-white text-ink-2 hover:bg-row-hover',
            )}
          >
            <Icon className="h-4 w-4 shrink-0" aria-hidden />
            <span>{t.label}</span>
          </button>
        );
      })}
    </div>
  );
}
