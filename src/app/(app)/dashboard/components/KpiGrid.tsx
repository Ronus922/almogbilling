import { CreditCard, Droplets, Zap, Mail, Flame, Gavel } from 'lucide-react';
import { KpiCard } from './KpiCard';
import type { DashboardKpis } from '@/lib/db/debtors';

const ils = new Intl.NumberFormat('he-IL', {
  style: 'currency',
  currency: 'ILS',
  maximumFractionDigits: 0,
});

export function KpiGrid({ kpis }: { kpis: DashboardKpis }) {
  return (
    <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-6">
      <KpiCard
        tone="purple"
        icon={CreditCard}
        title="חוב דמי ניהול"
        value={ils.format(kpis.managementDebtTotal)}
      />
      <KpiCard
        tone="sky"
        icon={Droplets}
        title="חוב מים חמים"
        value={ils.format(kpis.hotWaterDebtTotal)}
      />
      <KpiCard
        tone="amber"
        icon={Zap}
        title="לגבייה מיידית"
        value={String(kpis.immediateCollectionCount)}
      />
      <KpiCard
        tone="yellow"
        icon={Mail}
        title="מכתבי התראה"
        value={String(kpis.warningLetterCount)}
        subtitle="0 מכתבים"
      />
      <KpiCard
        tone="orange"
        icon={Flame}
        title="לטיפול משפטי"
        value={String(kpis.legalCareCount)}
      />
      <KpiCard
        tone="red"
        icon={Gavel}
        title="הליך משפטי"
        value={String(kpis.legalProceedingCount)}
      />
    </div>
  );
}
