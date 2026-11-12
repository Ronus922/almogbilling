import type { LucideIcon } from 'lucide-react';
import { cn } from '@/lib/utils';

// Shared parts of the chips skin (ref Chip.md), moved out of IssueChipSheet
// unchanged (12/11/2026) so the chip-order screens use the SAME section card
// and field tokens instead of a copy: the order sheet in /chips and the
// public page /chip-order. Valid only inside `.chips-skin`.

// ── Ref field tokens (Chip.md: input 44px, radius 11, border 1.5, focus ring) ─

export const INPUT_CLS =
  'h-11 rounded-[11px] border-[1.5px] border-[var(--chip-border)] bg-[var(--chip-panel)] px-[14px] text-[14.5px] text-[var(--chip-ink)] ' +
  'placeholder:text-[var(--chip-ink-soft)] ' +
  'focus-visible:border-[var(--chip-brand)] focus-visible:ring-4 focus-visible:ring-[rgba(61,90,254,0.12)]';

export const LABEL_CLS = 'flex items-center gap-1 text-[13px] font-bold text-[var(--chip-ink-muted)]';

// ── Section card (ref: white card, radius 16, head + divider, icon tile) ────

export type SectionTone = 'blue' | 'violet' | 'amber' | 'green';

const SECTION_TONE: Record<SectionTone, string> = {
  blue: 'bg-[var(--chip-brand-soft)] text-[var(--chip-brand)]',
  violet: 'bg-[var(--chip-violet-soft)] text-[var(--chip-violet)]',
  amber: 'bg-[var(--chip-amber-soft)] text-[var(--chip-amber)]',
  green: 'bg-[var(--chip-green-soft)] text-[var(--chip-green)]',
};

export function ChipSection({
  title, sub, icon: Icon, iconTone = 'blue', children,
}: {
  title: string;
  sub?: string;
  icon: LucideIcon;
  iconTone?: SectionTone;
  children: React.ReactNode;
}) {
  return (
    <section className="overflow-hidden rounded-[16px] border border-[var(--chip-border)] bg-[var(--chip-panel)]">
      <div className="flex items-center gap-[11px] border-b border-[var(--chip-border)] px-5 pb-[13px] pt-[15px]">
        <span
          className={cn(
            'grid h-[34px] w-[34px] shrink-0 place-items-center rounded-[10px]',
            SECTION_TONE[iconTone],
          )}
        >
          <Icon className="h-[19px] w-[19px]" strokeWidth={1.9} />
        </span>
        <div className="flex-1 text-start">
          <h2 className="text-[15.5px] font-extrabold tracking-[-0.01em] text-[var(--chip-ink)]">
            {title}
          </h2>
          {sub && (
            <div className="mt-0.5 text-[12.5px] font-medium text-[var(--chip-ink-soft)]">{sub}</div>
          )}
        </div>
      </div>
      <div className="p-4">{children}</div>
    </section>
  );
}
