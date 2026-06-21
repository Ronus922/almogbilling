import type { LucideIcon } from 'lucide-react';
import { cn } from '@/lib/utils';

export type KpiTone = 'purple' | 'cyan' | 'orange' | 'amber' | 'red' | 'green' | 'gray';

// Each tone: soft chip background + solid icon color + border in the same shade.
const toneStyles: Record<KpiTone, { soft: string; solid: string; border: string }> = {
  purple: { soft: 'bg-[#f1ecff]', solid: 'text-[#7c5cfc]', border: 'border-[#7c5cfc]/25' },
  cyan:   { soft: 'bg-[#e6fafe]', solid: 'text-[#0ba5c7]', border: 'border-[#0ba5c7]/25' },
  orange: { soft: 'bg-[#fff0e6]', solid: 'text-[#f2620f]', border: 'border-[#f2620f]/25' },
  amber:  { soft: 'bg-[#fff6e6]', solid: 'text-[#e08700]', border: 'border-[#e08700]/25' },
  red:    { soft: 'bg-[#feefef]', solid: 'text-[#e5484d]', border: 'border-[#e5484d]/25' },
  green:  { soft: 'bg-[#e9fbf0]', solid: 'text-[#16a34a]', border: 'border-[#16a34a]/25' },
  gray:   { soft: 'bg-[#f1f3f8]', solid: 'text-[#8a92a6]', border: 'border-[#8a92a6]/25' },
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
    <div className="rounded-2xl border border-line bg-white p-[18px] shadow-soft-xs transition-all duration-150 hover:-translate-y-0.5 hover:shadow-soft-md">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 pt-0.5 text-[13px] font-medium text-ink-2">{title}</div>
        <span
          className={cn(
            'grid h-10 w-10 shrink-0 place-items-center rounded-xl border',
            t.soft, t.solid, t.border,
          )}
        >
          <Icon className="h-5 w-5" aria-hidden />
        </span>
      </div>
      <div className="mt-3 flex items-baseline gap-2">
        <div className="font-num text-[26px] font-bold tracking-[-0.5px] text-ink">{value}</div>
        {subtitle && <div className="text-xs text-ink-3">{subtitle}</div>}
      </div>
    </div>
  );
}
