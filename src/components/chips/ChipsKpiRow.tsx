'use client';

import { Building2, Cpu, KeyRound, ShieldAlert, Smartphone } from 'lucide-react';
import { KpiCard } from '@/components/KpiCard';
import type { ChipsKpis } from '@/lib/types/chips';

// KPI strip for the chips page — 5 cards from GET /api/chips/kpis.
// Responsive inline grid (DESIGN.md §11 tones via the shared KpiCard).
export function ChipsKpiRow({ kpis }: { kpis: ChipsKpis | null }) {
  if (!kpis) {
    return (
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-5">
        {Array.from({ length: 5 }).map((_, i) => (
          <div key={i} className="h-[104px] animate-pulse rounded-2xl bg-muted/60" />
        ))}
      </div>
    );
  }

  return (
    <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-5">
      <KpiCard title="פעילים" value={String(kpis.active)} tone="green" icon={KeyRound} />
      <KpiCard title="באפליקציה" value={String(kpis.app_active)} tone="cyan" icon={Smartphone} />
      <KpiCard title="אבדו ב-30 יום" value={String(kpis.lost_30d)} tone="red" icon={ShieldAlert} />
      <KpiCard
        title="דירות ללא צ׳יפ פעיל"
        value={String(kpis.apartments_without_active)}
        subtitle={`מתוך ${kpis.apartments_total} דירות במרשם`}
        tone="amber"
        icon={Building2}
      />
      <KpiCard
        title="ממתין לחסימה בבקר"
        value={String(kpis.pending_controller)}
        tone="orange"
        icon={Cpu}
      />
    </div>
  );
}
