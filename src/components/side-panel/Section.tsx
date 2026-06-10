import type { LucideIcon } from 'lucide-react';
import { Card } from '@/components/ui/card';
import { cn } from '@/lib/utils';

interface Props {
  title: string;
  icon: LucideIcon;
  iconTone?: 'slate' | 'rose' | 'blue' | 'violet' | 'emerald' | 'amber';
  children: React.ReactNode;
  className?: string;
  /** Optional content rendered at the end of the header row (visual left in RTL). */
  headerSlot?: React.ReactNode;
  /** Optional small text rendered below the title (12px slate-500). */
  subtitle?: React.ReactNode;
}

const ICON_TONES: Record<NonNullable<Props['iconTone']>, string> = {
  slate:   'bg-slate-100 text-slate-600',
  rose:    'bg-rose-100 text-rose-600',
  blue:    'bg-blue-100 text-blue-600',
  violet:  'bg-violet-100 text-violet-600',
  emerald: 'bg-emerald-100 text-emerald-600',
  amber:   'bg-amber-100 text-amber-700',
};

export function Section({
  title, icon: Icon, iconTone = 'slate',
  children, className, headerSlot, subtitle,
}: Props) {
  return (
    <Card className={cn('ring-1 ring-slate-200/70 shadow-[0_1px_2px_rgba(15,23,42,0.04)]', className)}>
      <div className="flex items-center justify-between gap-2 px-4">
        {/* Right (RTL start): icon + title together */}
        <div className="flex items-center gap-2">
          <span className={cn('inline-flex h-8 w-8 items-center justify-center rounded-lg', ICON_TONES[iconTone])}>
            <Icon className="h-4 w-4" />
          </span>
          <h3 className="text-[26px] font-semibold text-slate-900">{title}</h3>
        </div>
        {/* Left (RTL end): optional extras */}
        {headerSlot ? <div className="flex items-center gap-2">{headerSlot}</div> : null}
      </div>
      {subtitle ? (
        <p className="px-4 text-[12px] text-slate-500 text-start -mt-2 whitespace-nowrap">
          {subtitle}
        </p>
      ) : null}
      <div className="px-4">{children}</div>
    </Card>
  );
}
