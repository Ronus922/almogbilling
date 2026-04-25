import { Card } from '@/components/ui/card';
import type { LucideIcon } from 'lucide-react';
import { cn } from '@/lib/utils';

export type KpiTone = 'purple' | 'sky' | 'amber' | 'yellow' | 'orange' | 'red';

const toneStyles: Record<KpiTone, { bg: string; fg: string }> = {
  purple: { bg: 'bg-purple-50', fg: 'text-purple-600' },
  sky:    { bg: 'bg-sky-50',    fg: 'text-sky-600' },
  amber:  { bg: 'bg-amber-50',  fg: 'text-amber-600' },
  yellow: { bg: 'bg-yellow-50', fg: 'text-yellow-600' },
  orange: { bg: 'bg-orange-50', fg: 'text-orange-600' },
  red:    { bg: 'bg-red-50',    fg: 'text-red-600' },
};

export function KpiCard({
  title,
  value,
  subtitle,
  tone,
  icon: Icon,
}: {
  title: string;
  value: string;
  subtitle?: string;
  tone: KpiTone;
  icon: LucideIcon;
}) {
  const t = toneStyles[tone];
  return (
    <Card className="p-5">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="text-sm text-muted-foreground">{title}</div>
          <div className="mt-2 text-2xl font-extrabold tracking-tight">{value}</div>
          {subtitle && <div className="mt-1 text-xs text-muted-foreground">{subtitle}</div>}
        </div>
        <div className={cn('grid h-10 w-10 shrink-0 place-items-center rounded-full', t.bg, t.fg)}>
          <Icon className="h-5 w-5" aria-hidden />
        </div>
      </div>
    </Card>
  );
}
