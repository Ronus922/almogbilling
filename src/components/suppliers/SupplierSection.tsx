import type { LucideIcon } from 'lucide-react';
import { cn } from '@/lib/utils';

/**
 * Entity section-card — DESIGN.md §28.7 — supplier-panel variant (per-instance,
 * NOT the shared `@/components/side-panel/Section`). Two families, pixel-exact
 * from the reference mockups:
 *
 *   detail (view/docs/history) → rounded-[18px] border-[#e9edf4] px-[26px] py-[22px];
 *     icon chip 34×34 rounded-[10px] (svg 17); h2 18px/800.
 *   create (new.html drawer)   → rounded-[14px] border-[#e7ebf1] px-5 py-[18px];
 *     icon chip 30×30 rounded-[9px] (svg 16); h2 16px/700.
 *
 * Tone hexes are taken verbatim from the mockups (no Tailwind token is exact).
 */
type EntityTone = 'blue' | 'amber' | 'emerald' | 'slate' | 'violet';

const TONE: Record<EntityTone, string> = {
  blue:    'bg-[#e8f0ff] text-[#2563eb]',
  amber:   'bg-[#fff3e6] text-[#ea8a18]',
  emerald: 'bg-[#e7f7ee] text-[#16a34a]',
  slate:   'bg-[#eef2f7] text-[#475569]',
  violet:  'bg-[#eef2ff] text-[#4f46e5]',
};

interface Props {
  title: string;
  icon: LucideIcon;
  iconTone?: EntityTone;
  variant?: 'detail' | 'create';
  children: React.ReactNode;
  className?: string;
  /** Optional content rendered at the header's logical end (left in RTL). */
  headerSlot?: React.ReactNode;
}

export function SupplierSection({
  title, icon: Icon, iconTone = 'slate', variant = 'detail',
  children, className, headerSlot,
}: Props) {
  const isCreate = variant === 'create';
  return (
    <section
      className={cn(
        isCreate
          ? 'rounded-[14px] border border-[#e7ebf1] px-5 py-[18px]'
          : 'rounded-[18px] border border-[#e9edf4] px-[26px] py-[22px]',
        'bg-white',
        className,
      )}
    >
      <div
        className={cn(
          'flex items-center justify-between',
          isCreate ? 'mb-4 gap-2.5' : 'mb-[18px] gap-[11px]',
        )}
      >
        {/* Right (RTL start): icon chip + title */}
        <div className={cn('flex items-center', isCreate ? 'gap-2.5' : 'gap-[11px]')}>
          <span
            className={cn(
              'inline-flex shrink-0 items-center justify-center',
              isCreate ? 'h-[30px] w-[30px] rounded-[9px]' : 'h-[34px] w-[34px] rounded-[10px]',
              TONE[iconTone],
            )}
          >
            <Icon className={isCreate ? 'h-4 w-4' : 'h-[17px] w-[17px]'} />
          </span>
          <h2
            className={cn(
              'text-slate-900',
              isCreate ? 'text-base font-bold' : 'text-lg font-extrabold',
            )}
          >
            {title}
          </h2>
        </div>
        {/* Left (RTL end): optional extras */}
        {headerSlot ? <div className="flex items-center gap-2">{headerSlot}</div> : null}
      </div>
      {children}
    </section>
  );
}
