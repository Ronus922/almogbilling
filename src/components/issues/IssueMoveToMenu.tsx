'use client';

// "העבר אל…" — how a phone moves an issue card to another kanban column (below
// 768px a long-press drag only reorders inside the column on screen). An icon
// button on the card — a 44px hit area — opens a Popover with the three other
// columns; a choice puts the card at the TOP of that column through the same
// drop the board uses (lib/issues/board.ts moveToAction), and "בוצע" closes the
// issue like a drop on it. Nothing here opens the issue panel: every event
// stops at the wrapper — React bubbles the popup's events through the portal
// up to the card otherwise.

import { useState, type SyntheticEvent } from 'react';
import { ArrowLeftRight } from 'lucide-react';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { cn } from '@/lib/utils';
import type { IssueBoardColumnDef, IssueBoardColumnKey } from '@/lib/issues/board';

const stop = (e: SyntheticEvent) => e.stopPropagation();

export function IssueMoveToMenu({ targets, onChoose }: {
  /** The columns offered — every column but the card's own (moveToTargets). */
  targets: IssueBoardColumnDef[];
  onChoose: (column: IssueBoardColumnKey) => void;
}) {
  const [open, setOpen] = useState(false);
  return (
    <div className="md:hidden" onClick={stop} onKeyDown={stop} onPointerDown={stop} onTouchStart={stop}>
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger
          aria-label="העבר אל…"
          className="-my-2 grid h-11 w-11 place-items-center rounded-lg text-slate-500 transition-colors hover:bg-slate-100 hover:text-slate-700"
        >
          <ArrowLeftRight className="h-4 w-4" />
        </PopoverTrigger>
        <PopoverContent align="end" className="w-56 p-2">
          <p className="px-3 pb-1 pt-1 text-xs font-semibold text-slate-400">העבר אל…</p>
          <ul dir="rtl" className="space-y-0.5">
            {targets.map((c) => (
              <li key={c.key}>
                <button
                  type="button"
                  onClick={() => { setOpen(false); onChoose(c.key); }}
                  className="flex min-h-11 w-full items-center gap-2.5 rounded-lg px-3 py-2 text-start text-sm font-medium text-slate-700 transition-colors hover:bg-slate-50"
                >
                  <span className={cn('h-2.5 w-2.5 shrink-0 rounded-full', c.dot)} aria-hidden />
                  {c.label}
                </button>
              </li>
            ))}
          </ul>
        </PopoverContent>
      </Popover>
    </div>
  );
}
