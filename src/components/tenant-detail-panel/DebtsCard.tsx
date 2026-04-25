import { Wallet } from 'lucide-react';
import { formatDistanceToNow } from 'date-fns';
import { he } from 'date-fns/locale';
import { Section } from './Section';
import { KpiCard } from './KpiCard';
import type { Tenant } from '@/types/tenant';

export function DebtsCard({ tenant }: { tenant: Tenant }) {
  const updatedLabel = tenant.last_imported_at
    ? formatDistanceToNow(new Date(tenant.last_imported_at), { addSuffix: true, locale: he })
    : '—';

  return (
    <Section
      title="פירוט חובות ותשלומים"
      icon={Wallet}
      iconTone="amber"
      subtitle={`עודכן לאחרונה: ${updatedLabel}`}
    >
      <div className="grid grid-cols-3 gap-3 pt-1">
        <KpiCard tone="rose"   label='סה"כ חוב'   value={tenant.total_debt} />
        <KpiCard tone="blue"   label="דמי ניהול"  value={tenant.management_fees} />
        <KpiCard tone="violet" label="מים חמים"   value={tenant.hot_water_debt} />
      </div>
    </Section>
  );
}
