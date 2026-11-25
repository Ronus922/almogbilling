import { AlarmClock, FlaskConical, PhoneOff } from 'lucide-react';
import { cn } from '@/lib/utils';
import {
  CHIP_ORDER_PHONE_UNVERIFIED_LABEL, CHIP_ORDER_STATUS_LABEL, CHIP_ORDER_TEST_LABEL, chipOrderStageLabel,
  type ChipOrderStage, type ChipOrderStatus,
} from '@/lib/chipOrders/model';

// The order's own status (the public tracking page) and the assigning stage
// of one apartment (the Orders tab, the "פרטי הזמנה" section of the issue
// window) — chips-skin tone families (DESIGN "מודול צ׳יפים").
const TONE: Record<ChipOrderStatus, string> = {
  pending_payment: 'border-[var(--chip-border-strong)] bg-[var(--chip-panel-alt)] text-[var(--chip-ink-muted)]',
  paid: 'border-[var(--chip-amber-border)] bg-[var(--chip-amber-soft)] text-[var(--chip-amber-ink)]',
  approved: 'border-[var(--chip-brand-border)] bg-[var(--chip-brand-soft)] text-[var(--chip-brand-ink)]',
  ready: 'border-[var(--chip-green-border)] bg-[var(--chip-green-soft)] text-[var(--chip-green-ink)]',
  collected: 'border-[var(--chip-border)] bg-[var(--chip-hover)] text-[var(--chip-ink-muted)]',
  rejected: 'border-[var(--chip-red-border)] bg-[var(--chip-red-soft)] text-[var(--chip-red-ink)]',
};

export function ChipOrderStatusPill({ status }: { status: ChipOrderStatus }) {
  return (
    <span className={cn('inline-flex h-[24px] items-center whitespace-nowrap rounded-[7px] border px-2.5 text-[12px] font-bold', TONE[status])}>
      {CHIP_ORDER_STATUS_LABEL[status]}
    </span>
  );
}

// ממתין לשיוך = amber (the old "paid") · שויכו X מתוך Y = brand · שויך = green
// soft · מוכן לאיסוף = solid green, so "ready" stands out from "assigned" ·
// נאסף = grey: done, nothing waits (a reception order, 25/11/2026).
const STAGE_TONE: Record<ChipOrderStage, string> = {
  awaiting: 'border-[var(--chip-amber-border)] bg-[var(--chip-amber-soft)] text-[var(--chip-amber-ink)]',
  partial: 'border-[var(--chip-brand-border)] bg-[var(--chip-brand-soft)] text-[var(--chip-brand-ink)]',
  assigned: 'border-[var(--chip-green-border)] bg-[var(--chip-green-soft)] text-[var(--chip-green-ink)]',
  ready: 'border-[var(--chip-green)] bg-[var(--chip-green)] text-white',
  collected: 'border-[var(--chip-border)] bg-[var(--chip-hover)] text-[var(--chip-ink-muted)]',
};

/** The stage of one apartment of an order, plus "באיחור" past the due date. */
export function ChipOrderStagePill({
  stage, linked, ordered, overdue = false,
}: { stage: ChipOrderStage; linked: number; ordered: number; overdue?: boolean }) {
  return (
    <span className="inline-flex flex-wrap items-center gap-1.5">
      <span data-testid="chip-order-stage" className={cn('inline-flex h-[24px] items-center whitespace-nowrap rounded-[7px] border px-2.5 text-[12px] font-bold', STAGE_TONE[stage])}>
        {chipOrderStageLabel(stage, linked, ordered)}
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
 *  section. Violet, so it never reads as a status. */
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

/** "טלפון לא אומת" — a test order created with "דלג על אימות (מצב בדיקה)"
 *  (13/11/2026): nobody proved the phone belongs to the orderer. Amber, with
 *  an icon, next to the "בדיקה" badge. */
export function ChipOrderUnverifiedPhoneBadge() {
  return (
    <span
      data-testid="chip-order-phone-unverified"
      className="inline-flex h-[24px] shrink-0 items-center gap-1 whitespace-nowrap rounded-[7px] border border-[var(--chip-amber-border)] bg-[var(--chip-amber-soft)] px-2.5 text-[12px] font-bold text-[var(--chip-amber-ink)]"
    >
      <PhoneOff className="h-3.5 w-3.5" />
      {CHIP_ORDER_PHONE_UNVERIFIED_LABEL}
    </span>
  );
}
