import Link from 'next/link';
import type { LucideIcon } from 'lucide-react';
import { cn } from '@/lib/utils';

// Tone presets for a widget's icon-chip + count badge. Colors map to the
// DESIGN.md §2 palette. chat/whatsapp use a solid badge (per the mockup); the
// rest use a soft badge.
export const CARD_TONES = {
  blue:    { chip: 'bg-blue-50 text-blue-600',       badge: 'bg-blue-50 text-blue-600' },
  violet:  { chip: 'bg-violet-50 text-violet-600',   badge: 'bg-violet-50 text-violet-600' },
  red:     { chip: 'bg-red-50 text-red-600',         badge: 'bg-red-50 text-red-600' },
  amber:   { chip: 'bg-amber-50 text-amber-700',     badge: 'bg-amber-50 text-amber-700' },
  brand:   { chip: 'bg-brand-soft text-brand',       badge: 'bg-brand text-white' },
  emerald: { chip: 'bg-emerald-50 text-emerald-600', badge: 'bg-emerald-600 text-white' },
} as const;

export type CardTone = keyof typeof CARD_TONES;

interface Props {
  icon: LucideIcon;
  tone: CardTone;
  title: string;
  /** Header count badge — hidden when null/0. */
  count?: number | null;
  /** Trailing "show all" link. */
  action?: { label: string; href: string };
  children: React.ReactNode;
}

/** The standard overview widget shell: header (icon-chip + title + count +
 *  action) over a divided list/grid body. */
export function OverviewCard({ icon: Icon, tone, title, count, action, children }: Props) {
  const t = CARD_TONES[tone];
  return (
    <section className="flex flex-col overflow-hidden rounded-2xl border border-line bg-white shadow-soft-xs">
      <div className="flex items-center justify-between gap-3 border-b border-line/70 px-4 py-3">
        <div className="flex min-w-0 items-center gap-2.5">
          <span className={cn('grid h-9 w-9 shrink-0 place-items-center rounded-[10px]', t.chip)}>
            <Icon className="h-[18px] w-[18px]" aria-hidden />
          </span>
          <h3 className="truncate text-base font-bold text-ink">{title}</h3>
          {count != null && count > 0 && (
            <span
              className={cn(
                'flex h-[22px] min-w-[22px] items-center justify-center rounded-full px-1.5 text-xs font-extrabold tabular-nums',
                t.badge,
              )}
            >
              {count}
            </span>
          )}
        </div>
        {action && (
          <Link
            href={action.href}
            className="-my-2 inline-flex min-h-[44px] shrink-0 items-center px-1 text-xs font-bold text-brand hover:underline"
          >
            {action.label}
          </Link>
        )}
      </div>
      <div className="flex flex-col divide-y divide-line/60">{children}</div>
    </section>
  );
}

/** Centered empty / error placeholder for a widget body. */
export function EmptyState({ message }: { message: string }) {
  return <div className="px-4 py-10 text-center text-sm text-ink-3">{message}</div>;
}
