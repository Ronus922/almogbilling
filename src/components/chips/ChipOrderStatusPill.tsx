import { AlarmClock, FlaskConical } from 'lucide-react';
import { cn } from '@/lib/utils';
import { CHIP_ORDER_STATUS_LABEL, CHIP_ORDER_TEST_LABEL, type ChipOrderStatus } from '@/lib/chipOrders/model';

// One status vocabulary for the orders list, the order panel and the public
// tracking page — chips-skin tone families (DESIGN "מודול צ׳יפים").
const TONE: Record<ChipOrderStatus, string> = {
  pending_payment: 'border-[var(--chip-border-strong)] bg-[var(--chip-panel-alt)] text-[var(--chip-ink-muted)]',
  paid: 'border-[var(--chip-amber-border)] bg-[var(--chip-amber-soft)] text-[var(--chip-amber-ink)]',
  approved: 'border-[var(--chip-brand-border)] bg-[var(--chip-brand-soft)] text-[var(--chip-brand-ink)]',
  ready: 'border-[var(--chip-green-border)] bg-[var(--chip-green-soft)] text-[var(--chip-green-ink)]',
  collected: 'border-[var(--chip-border)] bg-[var(--chip-hover)] text-[var(--chip-ink-muted)]',
  rejected: 'border-[var(--chip-red-border)] bg-[var(--chip-red-soft)] text-[var(--chip-red-ink)]',
};

export function ChipOrderStatusPill({ status, overdue = false }: { status: ChipOrderStatus; overdue?: boolean }) {
  return (
    <span className="inline-flex flex-wrap items-center gap-1.5">
      <span className={cn('inline-flex h-[24px] items-center whitespace-nowrap rounded-[7px] border px-2.5 text-[12px] font-bold', TONE[status])}>
        {CHIP_ORDER_STATUS_LABEL[status]}
      </span>
      {overdue && (
        <span className="inline-flex h-[24px] items-center gap-1 whitespace-nowrap rounded-[7px] bg-[var(--chip-red)] px-2.5 text-[12px] font-bold text-white">
          <AlarmClock className="h-3.5 w-3.5" />
          באיחור
        </span>
      )}
    </span>
  );
}

/** "בדיקה" — a test-mode order (13/11/2026): the orders list and the order
 *  panel. Violet, so it never reads as a status. */
export function ChipOrderTestBadge() {
  return (
    <span
      data-testid="chip-order-test-badge"
      className="inline-flex h-[24px] shrink-0 items-center gap-1 whitespace-nowrap rounded-[7px] border border-[var(--chip-violet-border)] bg-[var(--chip-violet-soft)] px-2.5 text-[12px] font-bold text-[var(--chip-violet-ink)]"
    >
      <FlaskConical className="h-3.5 w-3.5" />
      {CHIP_ORDER_TEST_LABEL}
    </span>
  );
}
