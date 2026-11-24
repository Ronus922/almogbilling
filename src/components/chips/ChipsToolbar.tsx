import type { ReactNode } from 'react';
import { Search } from 'lucide-react';
import { cn } from '@/lib/utils';

// The toolbar of a /chips tab — ONE frame for both tabs (25/11/2026), so the
// search box and the three export buttons stand at the same place in both:
// the tab's own controls at the start, then the search box, then the buttons,
// closing the toolbar at its far end.
//
// It lays itself out by the room the CARD has, not by the window's width
// (DESIGN §9: a 1024px window with the menu panel open leaves a ~650px card,
// where `lg:` is already on). The toolbar's own thin box is the container:
//   · under 720px   — everything stacked: the tab's controls, the search box
//                     across the card, the buttons sharing a line under it;
//   · 720–1139px    — the tab's controls on their own line; under them one
//                     line: the search box taking what is left, the buttons;
//   · from 1140px   — one line. The tab's controls take the room that is left
//                     and wrap INSIDE it, so a pill that shows up while typing
//                     ("מציג תוצאות מכל הסטטוסים") never pushes the search box
//                     away from under the cursor.

/** The look of a /chips search field. */
export const CHIPS_SEARCH_INPUT =
  'h-11 rounded-[11px] border-[1.5px] border-[var(--chip-border)] bg-[var(--chip-panel)] ps-[42px] pe-[14px] text-[14px] placeholder:text-[var(--chip-ink-soft)] focus-visible:border-[var(--chip-brand)] focus-visible:ring-4 focus-visible:ring-[rgba(61,90,254,0.12)]';

export function ChipsToolbar({
  children, search, searchWidth, exports,
}: {
  /** The tab's own controls, at the start. Nothing = the rest hugs the far end. */
  children?: ReactNode;
  /** The search field itself — an <Input className={CHIPS_SEARCH_INPUT}>. */
  search: ReactNode;
  /** The search box's width once the toolbar is one line — a class written
   *  out in full, e.g. "@min-[1140px]:w-[280px]". */
  searchWidth: string;
  /** The export buttons (ChipListExports). */
  exports: ReactNode;
}) {
  return (
    <div className="@container border-b border-[var(--chip-border)]">
      <div className="flex flex-wrap items-center gap-3 px-[22px] py-4 @min-[1140px]:flex-nowrap">
        {children && (
          <div className="flex min-w-0 flex-wrap items-center gap-2 @min-[1140px]:flex-1" data-testid="chips-toolbar-start">{children}</div>
        )}
        <div
          data-testid="chips-toolbar-end"
          className="flex w-full min-w-0 flex-col gap-2 @min-[720px]:flex-row @min-[720px]:items-center @min-[1140px]:ms-auto @min-[1140px]:w-auto @min-[1140px]:flex-none"
        >
          <div className={cn('relative w-full @min-[720px]:w-auto @min-[720px]:flex-1 @min-[1140px]:flex-none', searchWidth)}>
            <Search className="pointer-events-none absolute start-[13px] top-1/2 h-[17px] w-[17px] -translate-y-1/2 text-[var(--chip-ink-soft)]" />
            {search}
          </div>
          {exports}
        </div>
      </div>
    </div>
  );
}
