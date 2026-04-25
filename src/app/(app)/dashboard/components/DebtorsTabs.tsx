'use client';

import { useRouter, useSearchParams, usePathname } from 'next/navigation';
import {
  Users,
  Mail,
  AlertTriangle,
  Scale,
  CalendarClock,
  Archive,
  type LucideIcon,
} from 'lucide-react';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';
import type { TabCounts, TabKey } from '@/lib/db/debtors';

interface TabDef {
  key: TabKey;
  label: string;
  count: number;
  icon: LucideIcon;
  activeBg: string;
  badgeIdle: string;
  disabled?: boolean;
}

export function DebtorsTabs({
  active,
  counts,
}: {
  active: TabKey;
  counts: TabCounts;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  const tabs: TabDef[] = [
    { key: 'active',           label: 'חייבים',        count: counts.active,          icon: Users,         activeBg: 'bg-blue-600',   badgeIdle: 'bg-blue-100 text-blue-700' },
    { key: 'warning',          label: 'מכתבי התראה',  count: counts.warningLetter,   icon: Mail,          activeBg: 'bg-amber-600',  badgeIdle: 'bg-amber-100 text-amber-700' },
    { key: 'legal-care',       label: 'לטיפול משפטי', count: counts.legalCare,       icon: AlertTriangle, activeBg: 'bg-purple-600', badgeIdle: 'bg-purple-100 text-purple-700' },
    { key: 'legal-proceeding', label: 'הליך משפטי',    count: counts.legalProceeding, icon: Scale,         activeBg: 'bg-red-600',    badgeIdle: 'bg-red-100 text-red-700' },
    { key: 'actions',          label: 'פעולות',         count: counts.actions,         icon: CalendarClock, activeBg: 'bg-orange-600', badgeIdle: 'bg-orange-100 text-orange-700' },
    { key: 'archived',         label: 'ארכיון',         count: counts.archived,        icon: Archive,       activeBg: 'bg-slate-600',  badgeIdle: 'bg-slate-100 text-slate-600' },
  ];

  function go(key: TabKey) {
    const params = new URLSearchParams(searchParams.toString());
    if (key === 'active') params.delete('tab'); else params.set('tab', key);
    params.delete('page');
    const qs = params.toString();
    router.push(qs ? `${pathname}?${qs}` : pathname);
  }

  return (
    <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-2">
      {tabs.map((t) => {
        const isActive = t.key === active;
        const Icon = t.icon;
        const button = (
          <button
            type="button"
            onClick={() => !t.disabled && go(t.key)}
            disabled={t.disabled}
            className={cn(
              'h-10 w-full inline-flex items-center justify-center gap-1.5 rounded-lg px-3 py-2 text-xs sm:text-sm font-semibold transition-colors cursor-pointer',
              isActive
                ? `${t.activeBg} text-white`
                : 'bg-white text-slate-700 border border-slate-200 hover:bg-slate-50',
              t.disabled && 'cursor-not-allowed opacity-60',
            )}
            aria-current={isActive ? 'page' : undefined}
          >
            <Icon className="h-4 w-4 shrink-0" aria-hidden />
            <span>{t.label}</span>
            <span
              className={cn(
                'inline-flex items-center justify-center text-xs font-bold px-1.5 py-0.5 rounded-full',
                isActive ? 'bg-white/25 text-white' : t.badgeIdle,
              )}
            >
              {t.count}
            </span>
          </button>
        );
        if (t.disabled) {
          return (
            <Tooltip key={t.key}>
              <TooltipTrigger render={<span className="block" />}>{button}</TooltipTrigger>
              <TooltipContent>בקרוב</TooltipContent>
            </Tooltip>
          );
        }
        return <span key={t.key} className="block">{button}</span>;
      })}
    </div>
  );
}
