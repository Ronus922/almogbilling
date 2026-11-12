'use client';

import { ChevronLeft, ChevronRight } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { pageCount, pageRange, pageWindow } from '@/lib/pagination';
import { cn } from '@/lib/utils';

// The paging control under a table (DESIGN.md §9, "בקרת עמודים"): a caption — "מציג 51–100 מתוך
// 398" — and previous / numbered pages / next. Hidden when everything fits on one page.
//
// RTL: the DOM order is previous, 1 … N, next, so under dir=rtl "הקודם" sits at the right (the start)
// and "הבא" at the left, each with its chevron pointing the way it goes (§9: ChevronRight / ChevronLeft).
// Every control is a 44px <Button> (touch target). The current page is the solid brand one and carries
// aria-current="page".
//
// It follows the width of ITS OWN box (container queries), not the window's — with the navigation
// panel open a 1024px window leaves the card ~650px:
//   < 600px   previous · "עמוד 2 מתוך 8" · next, caption above (phones)
//   ≥ 600px   previous · the numbered pages · next
//   ≥ 760px   caption and controls on one row
// The numbered pages are always the same 7 slots (src/lib/pagination.ts), so the control never changes
// width as the page moves.

export interface PaginationProps {
  /** 1-based. */
  page: number;
  pageSize: number;
  /** The TRUE number of rows the current filters match — not the page's size. */
  total: number;
  onPageChange: (page: number) => void;
  /** The accessible name of the <nav>. */
  label?: string;
  className?: string;
}

export function Pagination({ page, pageSize, total, onPageChange, label = 'דפדוף בין עמודים', className }: PaginationProps) {
  const count = pageCount(total, pageSize);
  if (count <= 1) return null;

  const current = Math.min(Math.max(page, 1), count);
  const { from, to } = pageRange(current, pageSize, total);
  const go = (p: number) => { if (p !== current && p >= 1 && p <= count) onPageChange(p); };

  return (
    <div className={cn('@container', className)}>
      <nav
        aria-label={label}
        data-pagination
        className="flex flex-col items-center gap-3 @min-[760px]:flex-row @min-[760px]:justify-between"
      >
        <p data-pagination-caption className="text-sm tabular-nums text-slate-600">
          מציג {from}–{to} מתוך {total}
        </p>

        <div className="flex items-center gap-1.5">
          <Button
            type="button"
            variant="secondary"
            disabled={current <= 1}
            onClick={() => go(current - 1)}
            data-page-prev
          >
            <ChevronRight aria-hidden />
            הקודם
          </Button>

          <ol className="hidden items-center gap-1.5 @min-[600px]:flex">
            {pageWindow(current, count).map((slot) => (
              <li key={slot} className="flex">
                {typeof slot === 'number' ? (
                  <Button
                    type="button"
                    size="icon"
                    variant={slot === current ? 'default' : 'secondary'}
                    aria-label={`עמוד ${slot}`}
                    aria-current={slot === current ? 'page' : undefined}
                    onClick={() => go(slot)}
                    data-page={slot}
                    className="font-num tabular-nums"
                  >
                    {slot}
                  </Button>
                ) : (
                  <span aria-hidden className="grid h-11 w-7 place-items-center text-slate-400">…</span>
                )}
              </li>
            ))}
          </ol>
          <span data-pagination-position className="whitespace-nowrap px-2 text-sm tabular-nums text-slate-600 @min-[600px]:hidden">
            עמוד {current} מתוך {count}
          </span>

          <Button
            type="button"
            variant="secondary"
            disabled={current >= count}
            onClick={() => go(current + 1)}
            data-page-next
          >
            הבא
            <ChevronLeft aria-hidden />
          </Button>
        </div>
      </nav>
    </div>
  );
}
