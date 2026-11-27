import type { ComponentType } from 'react';
import { AlertTriangle, ConciergeBell, Hand, PackageCheck, PlusCircle, RotateCcw } from 'lucide-react';
import { CHIP_ORDER_TAG_LABEL, type ChipOrderTag } from '@/lib/chipOrders/orderRows';
import { ChipOrderTestBadge, ChipOrderUnverifiedPhoneBadge } from './ChipOrderStatusPill';

// The tags of an Orders-tab row (25/11/2026, Ronen): every flag of a row sits
// in the "תגיות" column — never next to the orderer's name, where rows with
// and without a tag used to look ragged. Kept apart from ChipOrderStatusPill,
// which the public tracking page loads too.

/** "הודעה נכשלה" — a message to the orderer (e-mail / WhatsApp) did not go
 *  out. Red, with the warning sign that used to stand alone next to the name. */
function ChipOrderNotifyFailedBadge() {
  return (
    <span
      data-testid="chip-order-notify-failed"
      title="שליחת הודעה נכשלה"
      className="inline-flex h-[24px] shrink-0 items-center gap-1 whitespace-nowrap rounded-[7px] border border-[var(--chip-red-border)] bg-[var(--chip-red-soft)] px-2.5 text-[12px] font-bold text-[var(--chip-red-ink)]"
    >
      <AlertTriangle className="h-3.5 w-3.5" />
      {CHIP_ORDER_TAG_LABEL.notify_failed}
    </span>
  );
}

/** "קבלה" — an order made at the reception (25/11/2026): the staff issued the
 *  chips in the issue window and recorded a payment received there. Brand
 *  blue, so it reads as where the order came from — neither a status nor a
 *  warning. */
function ChipOrderReceptionBadge() {
  return (
    <span
      data-testid="chip-order-reception-badge"
      title="הזמנה שנרשמה בקבלה — שולמה ונמסרה במקום"
      className="inline-flex h-[24px] shrink-0 items-center gap-1 whitespace-nowrap rounded-[7px] border border-[var(--chip-brand-border)] bg-[var(--chip-brand-soft)] px-2.5 text-[12px] font-bold text-[var(--chip-brand-ink)]"
    >
      <ConciergeBell className="h-3.5 w-3.5" />
      {CHIP_ORDER_TAG_LABEL.reception}
    </span>
  );
}

/** "צ׳יפים נוספים" — a reception order made for extra chips of a web order
 *  (25/11/2026): chips added in that order's window beyond what was paid
 *  online, and paid in cash or by transfer. Grey — a note next to "קבלה". */
function ChipOrderExtraBadge() {
  return (
    <span
      data-testid="chip-order-extra-badge"
      title="צ׳יפים שנוספו להזמנה מהאתר מעבר לכמות ששולמה, ושולמו בקבלה"
      className="inline-flex h-[24px] shrink-0 items-center gap-1 whitespace-nowrap rounded-[7px] border border-[var(--chip-border-strong)] bg-[var(--chip-panel-alt)] px-2.5 text-[12px] font-bold text-[var(--chip-ink-muted)]"
    >
      <PlusCircle className="h-3.5 w-3.5" />
      {CHIP_ORDER_TAG_LABEL.extra}
    </span>
  );
}

/** "בוטל ב-PayPlus — נדרש ביטול וזיכוי" (27/11/2026) — a paid order PayPlus
 *  shows cancelled or refunded (a signed callback, then PayPlus asked) that
 *  records no such refund: nothing was recorded and no Morning document went
 *  out — an admin finishes it with "ביטול וזיכוי". Red, the first tag; the
 *  only tag whose words may wrap (they are a sentence). */
function ChipOrderPayPlusReversalBadge() {
  return (
    <span
      data-testid="chip-order-payplus-reversal"
      title="PayPlus מראה שהחיוב בוטל או זוכה — יש להשלים ב„ביטול וזיכוי”"
      className="inline-flex min-h-[24px] max-w-full items-center gap-1 rounded-[7px] border border-[var(--chip-red-border)] bg-[var(--chip-red-soft)] px-2.5 py-0.5 text-[12px] font-bold leading-[1.3] text-[var(--chip-red-ink)]"
    >
      <RotateCcw className="h-3.5 w-3.5 shrink-0" />
      <span className="min-w-0">{CHIP_ORDER_TAG_LABEL.payplus_reversed}</span>
    </span>
  );
}

/** "נסגרה ידנית" (27/11/2026) — a super admin closed the order's stuck "ביטול
 *  וזיכוי" by hand: nothing was sent to PayPlus or Morning for the step it
 *  stopped at. Amber, for good — the window says who, when, why and which step. */
function ChipOrderClosedByHandBadge() {
  return (
    <span
      data-testid="chip-order-closed-by-hand-tag"
      title="„ביטול וזיכוי” נסגר ידנית על ידי סופר אדמין — הפרטים בחלון ההזמנה"
      className="inline-flex h-[24px] shrink-0 items-center gap-1 whitespace-nowrap rounded-[7px] border border-[var(--chip-amber-border)] bg-[var(--chip-amber-soft)] px-2.5 text-[12px] font-bold text-[var(--chip-amber-ink)]"
    >
      <Hand className="h-3.5 w-3.5" />
      {CHIP_ORDER_TAG_LABEL.closed_by_hand}
    </span>
  );
}

/** "נמסרה" (27/11/2026) — a web order handed over: it left the Orders tab and
 *  shows here when searched by its number, or while something on it is still
 *  open (a cancellation in PayPlus, a stuck "ביטול וזיכוי", a Morning document
 *  not issued). Green, like the hand-over it records. */
function ChipOrderDeliveredBadge() {
  return (
    <span
      data-testid="chip-order-delivered-tag"
      title="ההזמנה נמסרה — מעכשיו היא מופיעה בלשונית „צ׳יפים” דרך הצ׳יפים שלה"
      className="inline-flex h-[24px] shrink-0 items-center gap-1 whitespace-nowrap rounded-[7px] border border-[var(--chip-green-border)] bg-[var(--chip-green-soft)] px-2.5 text-[12px] font-bold text-[var(--chip-green-ink)]"
    >
      <PackageCheck className="h-3.5 w-3.5" />
      {CHIP_ORDER_TAG_LABEL.delivered}
    </span>
  );
}

const TAG_BADGE: Record<ChipOrderTag, ComponentType> = {
  payplus_reversed: ChipOrderPayPlusReversalBadge,
  closed_by_hand: ChipOrderClosedByHandBadge,
  delivered: ChipOrderDeliveredBadge,
  reception: ChipOrderReceptionBadge,
  extra: ChipOrderExtraBadge,
  test: ChipOrderTestBadge,
  phone_unverified: ChipOrderUnverifiedPhoneBadge,
  notify_failed: ChipOrderNotifyFailedBadge,
};

/** The tags of a row, in their order (chipOrderRowTags). */
export function ChipOrderTags({ tags }: { tags: ChipOrderTag[] }) {
  return (
    <>
      {tags.map((tag) => {
        const Badge = TAG_BADGE[tag];
        return <Badge key={tag} />;
      })}
    </>
  );
}
