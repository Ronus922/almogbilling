'use client';

import type { LucideIcon } from 'lucide-react';
import { Building2, Cpu, KeyRound, ShieldAlert, Smartphone } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { ChipsKpis } from '@/lib/types/chips';

// KPI strip — chips-skin (declared exception; EXTENDED from the ref card
// anatomy: white card, --chip-border, radius 16, icon tile in a soft tone).
// Local card markup instead of the shared KpiCard because the module palette
// is the ref's, not the global tones — scoped so nothing leaks out.

type ChipTone = 'green' | 'blue' | 'red' | 'amber' | 'violet';

const TONE_TILE: Record<ChipTone, string> = {
  green: 'bg-[var(--chip-green-soft)] text-[var(--chip-green)]',
  blue: 'bg-[var(--chip-brand-soft)] text-[var(--chip-brand)]',
  red: 'bg-[var(--chip-red-soft)] text-[var(--chip-red)]',
  amber: 'bg-[var(--chip-amber-soft)] text-[var(--chip-amber)]',
  violet: 'bg-[var(--chip-violet-soft)] text-[var(--chip-violet)]',
};

function ChipKpiCard({
  title,
  value,
  subtitle,
  tone,
  icon: Icon,
}: {
  title: string;
  value: string;
  subtitle?: string;
  tone: ChipTone;
  icon: LucideIcon;
}) {
  return (
    <div className="flex items-center gap-[13px] rounded-[16px] border border-[var(--chip-border)] bg-[var(--chip-panel)] p-4">
      <span className={cn('grid h-11 w-11 shrink-0 place-items-center rounded-[10px]', TONE_TILE[tone])}>
        <Icon className="h-[21px] w-[21px]" />
      </span>
      <div className="min-w-0">
        <div className="chip-num text-[22px] font-extrabold leading-tight text-[var(--chip-ink)]">
          {value}
        </div>
        <div className="truncate text-[12.5px] font-bold text-[var(--chip-ink-muted)]">{title}</div>
        {subtitle && (
          <div className="truncate text-[11.5px] font-medium text-[var(--chip-ink-soft)]">
            {subtitle}
          </div>
        )}
      </div>
    </div>
  );
}

// KPI strip for the chips page — 5 cards from GET /api/chips/kpis.
export function ChipsKpiRow({ kpis }: { kpis: ChipsKpis | null }) {
  if (!kpis) {
    return (
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-5">
        {Array.from({ length: 5 }).map((_, i) => (
          <div key={i} className="h-[88px] animate-pulse rounded-[16px] bg-[var(--chip-hover)]" />
        ))}
      </div>
    );
  }

  return (
    <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-5">
      <ChipKpiCard title="פעילים" value={String(kpis.active)} tone="green" icon={KeyRound} />
      <ChipKpiCard title="באפליקציה" value={String(kpis.app_active)} tone="blue" icon={Smartphone} />
      <ChipKpiCard title="אבדו ב-30 יום" value={String(kpis.lost_30d)} tone="red" icon={ShieldAlert} />
      <ChipKpiCard
        title="דירות ללא צ׳יפ פעיל"
        value={String(kpis.apartments_without_active)}
        subtitle={`מתוך ${kpis.apartments_total} דירות במרשם`}
        tone="amber"
        icon={Building2}
      />
      <ChipKpiCard
        title="ממתין לחסימה בבקר"
        value={String(kpis.pending_controller)}
        tone="violet"
        icon={Cpu}
      />
    </div>
  );
}
