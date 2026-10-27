'use client';

import { useLayoutEffect, useRef, type ReactNode } from 'react';
import { X } from 'lucide-react';
import { Button } from '@/components/ui/button';

/** "נבחרו 3 דירות" / "נבחרה דירה אחת". */
export function selectedApartmentsLabel(n: number): string {
  return n === 1 ? 'נבחרה דירה אחת' : `נבחרו ${n} דירות`;
}

/** The bar's live height, published on <html> so the things that must clear it
 *  (the list's bottom padding, the assistant button) can follow it. Those spell
 *  the name out in their Tailwind classes — keep them in step. */
const SELECTION_BAR_HEIGHT_VAR = '--selection-bar-h';

/**
 * The one action bar of the debtors table's checkbox selection. It owns only the
 * frame (count, clear); each bulk action (WhatsApp, legal status) is passed in as
 * children.
 *
 * Two placements, one switch at `md` (where the shell's sidebar appears):
 *  - Desktop/tablet: `sticky bottom-3` inside the table's box — visible while any
 *    row is on screen. The left padding is deliberate and physical: the assistant's
 *    floating button (AgentFab) is `fixed bottom-6 left-6`, 56px wide, ending 80px
 *    from the screen's left edge, while the bar starts ~34–40px in — `pl-14`
 *    (3.5rem ≈ 60px at the 17px root) keeps every control clear of it.
 *  - Phone (`<md`): `fixed inset-x-0 bottom-0`, full width, above the content and
 *    below every dialog (z-40, DESIGN §34's pattern). A sticky bar cannot leave its
 *    parent's box, so near the table's top edge it was pushed below the fold — on a
 *    phone the bar is ~240px tall (every control on its own row), so that was the
 *    lower third of the screen. Fixed has no such box. While it is on screen it
 *    publishes its height as `--selection-bar-h`; the list pads itself by it so the
 *    last card is never hidden, and the assistant button rides above it.
 */
export function DebtorsSelectionBar({
  count,
  onClear,
  children,
}: {
  count: number;
  onClear: () => void;
  children: ReactNode;
}) {
  const barRef = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    const el = barRef.current;
    if (!el) return;
    const root = document.documentElement;
    const publish = () => root.style.setProperty(SELECTION_BAR_HEIGHT_VAR, `${Math.ceil(el.getBoundingClientRect().height)}px`);
    publish();
    const observer = new ResizeObserver(publish);
    observer.observe(el);
    return () => {
      observer.disconnect();
      root.style.removeProperty(SELECTION_BAR_HEIGHT_VAR);
    };
  }, []);

  return (
    <div
      ref={barRef}
      role="region"
      aria-label="פעולות על הדירות שנבחרו"
      data-selection-bar=""
      className="sticky bottom-3 z-30 flex flex-wrap items-center gap-x-3 gap-y-2 rounded-xl border border-brand-border bg-brand-soft p-3 pl-14 shadow-soft-md max-md:fixed max-md:inset-x-0 max-md:bottom-0 max-md:z-40 max-md:mb-0 max-md:rounded-none max-md:border-x-0 max-md:border-b-0 max-md:pt-4 max-md:pr-[max(1rem,env(safe-area-inset-right))] max-md:pb-[max(1rem,env(safe-area-inset-bottom))] max-md:pl-[max(1rem,env(safe-area-inset-left))] max-md:shadow-[0_-4px_16px_rgba(15,23,42,0.08)]"
    >
      <span className="text-sm font-semibold text-brand-text">{selectedApartmentsLabel(count)}</span>
      {/* Second in the DOM so a phone shows it beside the count (first row);
          from `sm` it goes to the far end of the bar. */}
      <Button type="button" variant="ghost" onClick={onClear} className="ms-auto gap-1.5 px-3 sm:order-last">
        <X className="h-4 w-4" />
        נקה בחירה
      </Button>
      {children}
    </div>
  );
}
