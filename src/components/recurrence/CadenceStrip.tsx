'use client';

import { Repeat, Check } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { ChipState, ChipStrip } from '@/lib/recurrence/cadence';

// The recurrence strip — the single source of truth for how a cadence is shown
// (Iron Rule #8). Reused by the kanban card, the tasks table, the "מחזוריות" tab
// and the live preview inside the recurrence form, so a cadence never renders two
// different ways.
//
// Display only: everything it shows is resolved server-side (lib/db/tasks →
// lib/recurrence/cadence), because the "done" state depends on today in
// Asia/Jerusalem and must match between SSR and hydration.

type ChipSize = 'sm' | 'md';

const CHIP_SIZE: Record<ChipSize, string> = {
  sm: 'h-5 min-w-5 rounded text-[10px]',
  md: 'h-7 min-w-7 rounded-md text-xs',
};

/** Blue = scheduled, emerald = already done this period, slate = not scheduled. */
const CHIP_STATE: Record<ChipState, string> = {
  on: 'border-blue-600 bg-blue-50 text-blue-600',
  done: 'border-emerald-600 bg-emerald-50 text-emerald-700',
  off: 'border-slate-200 bg-white text-slate-300',
};

function Chip({ label, state, size }: { label: string; state: ChipState; size: ChipSize }) {
  return (
    <span
      aria-hidden
      className={cn(
        'inline-flex flex-none items-center justify-center border px-1 font-bold tabular-nums',
        CHIP_SIZE[size],
        CHIP_STATE[state],
      )}
    >
      {label}
    </span>
  );
}

/** Screen-reader summary — "כל שבוע · ג׳, ה׳" / "כל רבעון · חודשים 1, 4, 7, 10". */
function describe(label: string, chips: ChipStrip): string {
  switch (chips.type) {
    case 'weekdays': {
      const on = chips.days.filter((d) => d.state !== 'off').map((d) => d.label);
      return on.length > 0 ? `${label} · ${on.join(', ')}` : label;
    }
    case 'monthday':
      return `${label} · ${chips.label}`;
    case 'months': {
      const on = chips.months.filter((m) => m.state !== 'off').map((m) => m.month);
      return on.length > 0 ? `${label} · חודשים ${on.join(', ')}` : label;
    }
    case 'none':
      return label;
  }
}

function CadenceLabel({ label, size }: { label: string; size: ChipSize }) {
  return (
    <span
      className={cn(
        'inline-flex flex-none items-center gap-1 font-semibold text-blue-600',
        size === 'sm' ? 'text-[11px]' : 'text-xs',
      )}
    >
      <Repeat className={size === 'sm' ? 'h-3 w-3' : 'h-3.5 w-3.5'} />
      {label}
    </span>
  );
}

interface Props {
  /** Resolved cadence label — "כל שבוע" / "כל רבעון". */
  label: string;
  chips: ChipStrip;
  size?: ChipSize;
  className?: string;
}

export function CadenceStrip({ label, chips, size = 'sm', className }: Props) {
  const summary = describe(label, chips);

  // Twelve month chips need the full width, so the label moves onto its own line
  // and the chips wrap inside a subtle container instead of squeezing the card.
  if (chips.type === 'months') {
    return (
      <div
        aria-label={summary}
        className={cn(
          'flex flex-col gap-1.5 rounded-lg border border-slate-100 bg-slate-50/60 p-2',
          className,
        )}
      >
        <CadenceLabel label={label} size={size} />
        <div className="flex flex-wrap items-center gap-1">
          {chips.months.map((m) => (
            <Chip key={m.month} label={String(m.month)} state={m.state} size={size} />
          ))}
        </div>
      </div>
    );
  }

  return (
    <div
      aria-label={summary}
      className={cn('flex items-center justify-between gap-2', className)}
    >
      <CadenceLabel label={label} size={size} />
      {chips.type === 'weekdays' && (
        <div className="flex items-center gap-1">
          {chips.days.map((d) => (
            <Chip key={d.index} label={d.label} state={d.state} size={size} />
          ))}
        </div>
      )}
      {chips.type === 'monthday' && (
        <span
          aria-hidden
          className={cn(
            'inline-flex flex-none items-center rounded-md border border-blue-600 bg-blue-50 px-2 font-bold text-blue-600',
            size === 'sm' ? 'h-5 text-[10px]' : 'h-7 text-xs',
          )}
        >
          {chips.label}
        </span>
      )}
    </div>
  );
}

interface ProgressProps {
  doneCount: number;
  expectedCount: number;
  /** "השבוע" / "השנה". */
  periodLabel: string | null;
}

/**
 * Per-period progress — "1/3 השבוע". Deliberately hidden unless the cadence
 * expects MORE THAN ONE occurrence per period and at least one is done: a
 * "1/1 החודש" badge would be pure noise, which is why the reference design shows
 * it only on the three-day weekly card.
 */
export function CadenceProgress({ doneCount, expectedCount, periodLabel }: ProgressProps) {
  if (expectedCount <= 1 || doneCount <= 0 || !periodLabel) return null;
  return (
    <span className="inline-flex flex-none items-center gap-1 rounded-md bg-emerald-50 px-2 py-0.5 text-[11px] font-bold text-emerald-700">
      <span dir="ltr" className="tabular-nums">{`${doneCount}/${expectedCount}`}</span>
      {periodLabel}
      <Check className="h-3 w-3" />
    </span>
  );
}
