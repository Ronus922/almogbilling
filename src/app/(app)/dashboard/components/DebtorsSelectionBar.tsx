'use client';

import type { ReactNode } from 'react';
import { X } from 'lucide-react';
import { Button } from '@/components/ui/button';

/** "נבחרו 3 דירות" / "נבחרה דירה אחת". */
export function selectedApartmentsLabel(n: number): string {
  return n === 1 ? 'נבחרה דירה אחת' : `נבחרו ${n} דירות`;
}

/**
 * The one action bar of the debtors table's checkbox selection — sticky at the
 * bottom of the table while rows are selected. It owns only the frame (count,
 * clear); each bulk action (WhatsApp, legal status) is passed in as children.
 *
 * The left padding is deliberate and physical: the assistant's floating button
 * (AgentFab) is `fixed bottom-6 left-6`, 56px wide, ending 80px from the screen's
 * left edge, while the bar starts ~34–40px in — `pl-14` (3.5rem ≈ 60px at the
 * 17px root) keeps every control clear of it. The e2e spec measures the overlap.
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
  return (
    <div
      role="region"
      aria-label="פעולות על הדירות שנבחרו"
      className="sticky bottom-3 z-30 flex flex-wrap items-center gap-x-3 gap-y-2 rounded-xl border border-brand-border bg-brand-soft p-3 pl-14 shadow-soft-md"
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
