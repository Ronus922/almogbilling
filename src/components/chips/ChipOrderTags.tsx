import type { ComponentType } from 'react';
import { AlertTriangle, ConciergeBell } from 'lucide-react';
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

const TAG_BADGE: Record<ChipOrderTag, ComponentType> = {
  reception: ChipOrderReceptionBadge,
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
