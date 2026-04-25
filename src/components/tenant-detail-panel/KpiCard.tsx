import type { LucideIcon } from 'lucide-react';
import { Wallet, Building2, Droplets } from 'lucide-react';
import { Card } from '@/components/ui/card';
import { cn } from '@/lib/utils';

const ils = new Intl.NumberFormat('he-IL', {
  style: 'currency',
  currency: 'ILS',
  maximumFractionDigits: 0,
});

export type KpiTone = 'rose' | 'blue' | 'violet';

const TONES: Record<KpiTone, { bg: string; ring: string; fg: string; Icon: LucideIcon }> = {
  rose:   { bg: 'from-rose-50 to-rose-50/40',     ring: 'ring-rose-200/60',   fg: 'text-rose-600',   Icon: Wallet },
  blue:   { bg: 'from-blue-50 to-blue-50/40',     ring: 'ring-blue-200/60',   fg: 'text-blue-600',   Icon: Building2 },
  violet: { bg: 'from-violet-50 to-violet-50/40', ring: 'ring-violet-200/60', fg: 'text-violet-600', Icon: Droplets },
};

interface Props {
  tone: KpiTone;
  label: string;
  value: number;
}

export function KpiCard({ tone, label, value }: Props) {
  const t = TONES[tone];
  const Icon = t.Icon;
  return (
    <Card className={cn('bg-gradient-to-br', t.bg, 'ring-1', t.ring, 'ring-inset')}>
      <div className="flex items-start justify-between px-4">
        <div className="space-y-1">
          <div className="text-xs text-muted-foreground">{label}</div>
          <div className={cn('text-2xl font-bold tabular-nums', t.fg)}>
            {ils.format(value)}
          </div>
        </div>
        <Icon className={cn('h-5 w-5 opacity-60', t.fg)} />
      </div>
    </Card>
  );
}
