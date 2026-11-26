'use client';

// "פירוט עסקה" of the issue window (v2 design of 24/11/2026, `.inv` of
// ref/chip-order/chip-issue-admin-v2.html): the order's number and tags, who
// ordered (three columns), status, the due date, "שויכו X מתוך Y", one line
// per apartment (its people, role, quantity, price), the price lines from the
// order's own snapshot, the total — and the row of status buttons: "מוכן
// לאיסוף", "נאסף", "דחה" and, at the far end, "מחק הזמנת בדיקה" (test orders
// only; it disables the order's chips first).
//
// DECLARED DEVIATION from the reference (Ronen, 24/11/2026): the reference
// opens the row with a fourth button, "בטיפול". The system has no such status
// — a paid order is simply open, and no server move leads into it — so the
// element is left out altogether: not greyed and not turned into a label. The
// row holds the real actions only.
//
// The three are ALWAYS drawn; what an order cannot do right now is disabled
// (greyed), not hidden. The actions themselves did not change: paid → ready →
// collected, or paid → rejected. Three looks: the stage the order is in now =
// an outlined button at full strength that is not pressed (a mark); its next
// step = the filled button; everything else = greyed. A paid order has no
// mark in the row — where it stands is the "סטטוס" tag above. An order that
// was collected or rejected somewhere else while its row was still on this
// screen opens too: its closing stage is the mark and nothing is offered. The
// status belongs to the whole order.
//
// "מוכן לאיסוף" IS ONE CLICK (24/11/2026): the window decides when it may be
// pressed and what the click does — save what is waiting, then mark the order
// ready (OrderIssueSheet `markReady`); this card only draws the button. And
// whenever the button cannot be pressed, the reason is a line of text under
// the row, always on the screen — a tooltip alone says nothing on a touch
// screen, and nobody hovers over a greyed button to find out why.
//
// 25/11/2026 (round six):
//   · "נאסף" asks first, and MAY name who collected — one of the people of the
//     order (optional here; on the guard's pickup screen it is required). A
//     closed order says who collected, who handed over, where and when;
//   · a RECEPTION order (cash or transfer) can be cancelled — "בטל הזמנת
//     קבלה", admin and super admin only, with a required reason: its chips are
//     disabled (never deleted), nobody is notified, and the order stays in the
//     table as "בוטל";
//   · extra chips that were added to this order and paid at the reception are
//     listed under the total (each is a reception order of its own).
//
// 26/11/2026 (card payments through PayPlus, documents through Morning) —
// three blocks under the details grid, each a small heading over the grid's
// own three columns:
//   · "תשלום" — ONE block: the method, the amount paid; for a card the last
//     four digits, the approval number, the time and the environment
//     ("סביבת בדיקות" amber, "חיוב אמיתי"); for cash / a transfer who
//     recorded it and when;
//   · "זיכוי" — when the order has a refund state: what it is, how much, when,
//     by whom, from where, why, PayPlus's own words when it has to be done by
//     hand, and "ממתינה לתשובה" while PayPlus has not answered yet;
//   · "מסמכים" — each Morning document (invoice / credit) with its number as a
//     link, or where it stands; a failed one says why, and an admin may send
//     it back to the queue ("הפק חשבונית שוב").
//   And one more button: "ביטול וזיכוי" (27/11/2026) — admin and super admin
//   only — the one way back of an order: a reception order, or a web order
//   the card paid, in any status (ReceptionCancelDialog, POST
//   /api/chip-orders/[id]/cancel). "דחה" of a card order runs the same steps.
//   A charge PayPlus showed cancelled / refunded after a callback carries the
//   warning "בוטל ב-PayPlus — נדרש ביטול וזיכוי", and nothing moves the order
//   on until "ביטול וזיכוי" finishes it.

import { useState } from 'react';
import { toast } from 'sonner';
import { Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import {
  AlertDialog, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter,
  AlertDialogHeader, AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { cn } from '@/lib/utils';
import {
  CHIP_ORDER_CANCELLED_LABEL, CHIP_ORDER_PHONE_UNVERIFIED_LABEL, CHIP_ORDER_REFUND_LABEL, CHIP_ORDER_TEST_LABEL, chipOrderStage,
  chipOrderStageLabel, formatIlsAfter, isChipOrderOverdue, type ChipOrderRefundStatus, type ChipOrderWindow,
  type ChipOrderWindowOrder,
} from '@/lib/chipOrders/model';
import { chipOrderDocState } from '@/lib/chipOrders/orderRows';
import { PICKUP_ORDERER_KEY } from '@/lib/chipOrders/pickup';
import { CHIP_ORDER_EXTRA_LABEL, CHIP_ORDER_RECEPTION_LABEL, STORED_PAYMENT_LABEL } from '@/lib/chipOrders/reception';
import { e164ToLocal } from '@/lib/portal/phone';
import {
  PAYPLUS_REVERSAL_LABEL, PAYPLUS_REVERSAL_NEXT, PAYPLUS_REVERSAL_TEXT, RECEPTION_CANCEL_LABEL, receptionCancelStoppedText,
} from '@/lib/chipOrders/receptionCancelText';
import { CollectorPicker, type CollectorOption } from '../CollectorPicker';
import { ReceptionCancelDialog } from '../ReceptionCancelDialog';
import { AlertIco, CheckIco, Ico, ROLE_SHORT, TrashIco, roleTone } from './parts';

const DUE = new Intl.DateTimeFormat('he-IL', {
  timeZone: 'Asia/Jerusalem', day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
});

const phoneView = (p: string | null) => (p ? (p.startsWith('+972') ? e164ToLocal(p) : p) : '');

/** What the order's routes answer — each reads the fields of its own. */
interface ActionAnswer {
  ok?: boolean;
  error?: string;
  /** "דחה". */
  refund_status?: ChipOrderRefundStatus;
  refund_label?: string;
  refund_note?: string | null;
  /** "דחה" of an order the card paid: the step of "ביטול וזיכוי" that stopped (27/11/2026). */
  failed_step?: 'refund' | 'credit' | 'cancel' | null;
  /** "הפק חשבונית שוב". */
  queued?: number;
}

async function postJson(url: string, body?: unknown, method = 'POST'): Promise<ActionAnswer> {
  const res = await fetch(url, {
    method,
    credentials: 'include',
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = (await res.json().catch(() => ({}))) as ActionAnswer;
  if (!res.ok) throw new Error(data.error === 'not_found' ? 'ההזמנה לא נמצאה' : data.error ?? 'הפעולה נכשלה');
  return data;
}

/** The role tag of an apartment line: one role = its name in the tone of the
 *  holder block's tag (owner brand, renter amber, the rest grey). The last
 *  line is NOT the role `other` (that one is "אורח", through ROLE_SHORT): it
 *  names a line whose people hold a mix of roles other than owner + renter. */
function roleOf(roles: string[]): { label: string; tone: ReturnType<typeof roleTone> } {
  const set = new Set(roles);
  if (set.size === 1) {
    const role = roles[0]!;
    return { label: ROLE_SHORT[role] ?? role, tone: roleTone(role) };
  }
  if (set.has('owner') && set.has('tenant')) return { label: 'בעלים + שוכר', tone: undefined };
  return { label: 'אחר', tone: 'ci-other' };
}

/** Where a refund came from — the "דרך" cell of the refund block. */
const REFUND_VIA_LABEL: Record<NonNullable<ChipOrderWindowOrder['refund_via']>, string> = {
  admin: RECEPTION_CANCEL_LABEL,
  reject: 'דחייה',
  reception_cancel: `${RECEPTION_CANCEL_LABEL} (קבלה)`,
  payplus: 'בממשק PayPlus',
};

/** The tone of the refund state: done (green), part of it (amber), by hand (red), none due (grey). */
const REFUND_TONE: Record<ChipOrderRefundStatus, string> = {
  refunded: 'ci-green',
  partial: 'ci-amber',
  manual_required: 'ci-red',
  not_required: 'ci-grey',
};

const CheckAllIco = () => <Ico size={13} sw={2}><path d="M20 7 10 17l-6-6" /><path d="M22 11 12 21l-2-2" /></Ico>;
const FlaskIco = () => <Ico size={11} sw={2.2} join={false}><path d="M10 2v6L4.5 18a2 2 0 0 0 1.8 3h11.4a2 2 0 0 0 1.8-3L14 8V2M8.5 2h7" /></Ico>;
const PayIco = () => <Ico size={14}><rect x="2" y="5" width="20" height="14" rx="2" /><path d="M2 10h20" /></Ico>;
const RefundIco = ({ size = 14 }: { size?: number }) => <Ico size={size}><path d="M9 14 4 9l5-5" /><path d="M4 9h10.5a5.5 5.5 0 0 1 0 11H11" /></Ico>;
const DocIco = () => <Ico size={14}><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8Z" /><path d="M14 2v6h6M16 13H8M16 17H8M10 9H8" /></Ico>;
const LinkIco = () => <Ico size={12} sw={2.2}><path d="M15 3h6v6M10 14 21 3M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" /></Ico>;

export function OrderTransaction({
  win, readyAction, canEditOrders, canAdminOrders = false, disabled, onGone, onReload, onModalChange,
}: {
  win: ChipOrderWindow;
  /** "מוכן לאיסוף" of an order that is being assigned: whether it may be
   *  pressed now, why not (`reason`, shown under the buttons), and the click —
   *  which saves the window first. */
  readyAction: { can: boolean; busy: boolean; reason: string | null; run: () => void };
  /** chips_orders_manage:edit — the order's buttons. */
  canEditOrders: boolean;
  /** Admin / super admin, by role — "ביטול וזיכוי" and "הפק חשבונית שוב"
   *  (each route asks again: requireAdmin). */
  canAdminOrders?: boolean;
  disabled: boolean;
  /** The order left the open list (collected / rejected / deleted / refunded). */
  onGone: () => void;
  /** Load the order again, in the window and behind it — after an action
   *  that keeps the window open (a refund PayPlus refused, a document sent
   *  back to the queue). */
  onReload: () => void;
  onModalChange: (open: boolean) => void;
}) {
  const [busy, setBusy] = useState<string | null>(null);
  const [rejectOpen, setRejectOpen] = useState(false);
  const [rejectReason, setRejectReason] = useState('');
  const [deleteOpen, setDeleteOpen] = useState(false);
  // "נאסף": asked first; who collected is optional.
  const [collectOpen, setCollectOpen] = useState(false);
  const [collector, setCollector] = useState<string | null>(null);
  // "ביטול וזיכוי" (27/11/2026): the shared confirmation (ReceptionCancelDialog).
  const [cancelOpen, setCancelOpen] = useState(false);

  const o = win.order;
  const ordered = win.items.reduce((s, i) => s + i.chips_count, 0);
  const linked = win.items.reduce((s, i) => s + Math.min(i.chips_linked, i.chips_count), 0);
  const linkedAll = win.items.reduce((s, i) => s + i.chips_linked, 0);
  const stage = chipOrderStage(o.status, linkedAll, ordered, o.source);
  const overdue = isChipOrderOverdue(o);
  const assigning = o.status === 'paid' || o.status === 'approved';
  const ready = o.status === 'ready';
  // Closed orders leave the Orders tab, but that list does not refresh on its
  // own: a row another user (or tab) already closed still opens this window.
  const collected = o.status === 'collected';
  const rejected = o.status === 'rejected';
  // Paid at the reception and handed over on the spot (25/11/2026): the order
  // was collected the moment it was made. No clearing, no message to anyone.
  const reception = o.source === 'reception';
  // Paid by card: the processor confirmed a charge (PayPlus, 25/11/2026).
  const cardPaid = o.card_status === 'paid';
  // A test card in PayPlus's sandbox — no money moved.
  const sandbox = o.card_env === 'sandbox';
  const paidAmount = cardPaid ? o.card_paid_amount ?? o.total : o.total;
  // "ביטול וזיכוי" (27/11/2026) — the one way back, admin and super admin:
  // a reception order collected, or paid by card with its chips never saved;
  // a web order the card paid, in any status, until its run finished. (It
  // replaced "בטל הזמנת קבלה" and "זיכוי".)
  const cancellable = !o.cancel_completed && (reception
    ? collected || (o.status === 'paid' && cardPaid)
    // (A web order refunded in full before 27/11/2026 has nothing left to run.)
    : cardPaid && o.status !== 'pending_payment' && !(o.refund_status === 'refunded' && !o.cancel_requested));
  // A refund waiting for PayPlus's answer (it may have gone through — it is
  // never sent again): the order is not moved on — no "מוכן לאיסוף", "נאסף"
  // or "דחה" — until "ביטול וזיכוי" settles it (the refund block says so).
  // PayPlus showed the charge cancelled / refunded after a callback
  // (27/11/2026): the money went back — nothing moves the order on either.
  const reversal = o.payplus_reversal_kind ?? null;
  const refundPending = o.refund_in_flight === true || reversal !== null;
  const PENDING_REFUND = reversal
    ? `${PAYPLUS_REVERSAL_LABEL} — ההזמנה לא מתקדמת עד „ביטול וזיכוי”`
    : 'בקשת זיכוי נשלחה ל-PayPlus בלי תשובה — ממשיכים ב„ביטול וזיכוי”';

  // Price lines from the order's own snapshot (per apartment). An order since
  // 21/11/2026 has one flat price (price_above = unit_price) → ONE line; an
  // older order keeps the threshold rule it was sold with → its two lines.
  let base = 0, above = 0, baseCents = 0, aboveCents = 0;
  for (const i of win.items) {
    const b = Math.min(i.chips_count, i.threshold);
    const a = Math.max(0, i.chips_count - i.threshold);
    base += b; above += a;
    baseCents += b * Math.round(i.unit_price * 100);
    aboveCents += a * Math.round(i.price_above * 100);
  }
  const first = win.items[0];
  const tiered = above > 0 && win.items.some((i) => i.price_above !== i.unit_price);

  function setModal(kind: 'reject' | 'delete' | 'collect' | 'cancel', open: boolean) {
    if (kind === 'reject') setRejectOpen(open);
    else if (kind === 'delete') setDeleteOpen(open);
    else if (kind === 'collect') setCollectOpen(open);
    else setCancelOpen(open);
    onModalChange(open);
  }

  // Who may be named as the person who collected: the people of the order,
  // each once (a block with no holder line of its own is the orderer's).
  const aptOf = (itemId: string) => win.items.find((i) => i.id === itemId)?.apartment_number ?? '';
  const collectors: CollectorOption[] = [];
  for (const h of win.holders) {
    const key = h.id ?? PICKUP_ORDERER_KEY;
    if (!collectors.some((c) => c.key === key)) collectors.push({ key, name: h.full_name, apartment: aptOf(h.item_id) });
  }
  const cancelled = reception && rejected;

  /** "נאסף", "דחה" and "מחק הזמנת בדיקה" — each takes the order out of the
   *  open list, so the window closes after it. `ok` is the
   *  success message, or what to say from the answer. */
  async function act(key: string, run: () => Promise<ActionAnswer>, ok: string | ((data: ActionAnswer) => void)): Promise<boolean> {
    setBusy(key);
    try {
      const data = await run();
      if (typeof ok === 'function') ok(data);
      else toast.success(ok);
      onGone();
      return true;
    } catch (e) {
      toast.error((e as Error).message);
      return false;
    } finally {
      setBusy(null);
    }
  }

  /** "דחה" — the toast says how the money went back (a card: PayPlus's
   *  outcome; anything else: by hand). */
  function afterReject(data: ActionAnswer) {
    const detail = data.refund_label ? `זיכוי: ${data.refund_label}${data.refund_note ? ` — ${data.refund_note}` : ''}` : undefined;
    if (data.failed_step) toast.warning(`ההזמנה נדחתה — ${receptionCancelStoppedText(data.failed_step)}`, { description: detail });
    else if (data.refund_status === 'manual_required') toast.warning('ההזמנה נדחתה — הזיכוי לא בוצע אוטומטית', { description: detail });
    else toast.success('ההזמנה נדחתה', detail ? { description: detail } : undefined);
  }

  /** "הפק חשבונית שוב" — the order's FAILED documents go back to the queue
   *  (the server never makes a second document), and the window loads again. */
  async function retryDocuments() {
    setBusy('retry');
    try {
      const data = await postJson(`/api/chip-orders/${o.id}/documents/retry`);
      const queued = data.queued ?? 0;
      if (queued > 0) toast.success(queued === 1 ? 'המסמך נשלח להפקה מחדש' : `${queued} מסמכים נשלחו להפקה מחדש`, { description: 'מורנינג יפיק אותו בדקות הקרובות' });
      else toast.info('אין מסמך שנכשל — אין מה להפיק מחדש');
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy(null);
      onReload();
    }
  }

  const stageTag = stage === 'ready' ? 'ci-solid'
    : stage === 'collected' ? 'ci-grey'
      : stage === 'assigned' ? 'ci-green'
        : stage === 'rejected' || stage === 'cancelled' ? 'ci-red'
          : 'ci-amber';
  // Why "מוכן לאיסוף" cannot be pressed — a visible line, not only a tooltip.
  // Amber while something is still missing; quiet once the order moved on.
  const readyNote: { text: string; quiet: boolean } | null = assigning
    ? (readyAction.reason ? { text: readyAction.reason, quiet: false } : null)
    : ready ? { text: 'ההזמנה כבר מוכנה לאיסוף — השלב הבא: „נאסף”', quiet: true }
      : collected ? { text: reception ? 'הזמנת קבלה: שולמה ונמסרה במקום — ההזמנה סגורה' : 'ההזמנה כבר נאספה', quiet: true }
        : rejected ? { text: reception ? 'הזמנת הקבלה בוטלה — הצ׳יפים שלה הושבתו' : 'ההזמנה נדחתה', quiet: true }
          : null;

  // How the order was paid, as stored.
  const methodLabel = cardPaid
    ? STORED_PAYMENT_LABEL.card
    : o.payment_method ? STORED_PAYMENT_LABEL[o.payment_method] ?? o.payment_method : '—';
  const recordedBy = Boolean(o.payment_recorded_by_name || o.payment_recorded_at);
  const refundShown = o.refund_status != null || o.refund_in_flight === true;
  const documents = o.documents ?? [];
  const failedDocuments = documents.some((d) => d.status === 'failed');

  const rejectText = cardPaid
    ? o.is_test || sandbox
      ? 'הזמנת בדיקה: היא תסומן „נדחה” ויבוצע זיכוי מלא לכרטיס הבדיקה, בסביבת הבדיקות של PayPlus (אין כסף אמיתי). המזמין יקבל מייל ווואטסאפ עם הסיבה.'
      : 'ההזמנה תסומן „נדחה” ויבוצע זיכוי מלא לכרטיס דרך PayPlus. המזמין יקבל מייל ווואטסאפ עם הסיבה ומצב הזיכוי.'
    : o.is_test
      ? 'הזמנת בדיקה: היא תסומן „נדחה” (לא היה חיוב — הזיכוי „לא נדרש (בדיקה)”). המזמין יקבל מייל ווואטסאפ עם הסיבה.'
      : 'ההזמנה תסומן „נדחה”. היא לא שולמה בכרטיס דרך המערכת, ולכן את הכסף מחזירים ידנית (הזיכוי יסומן „דורש זיכוי ידני”). המזמין יקבל מייל ווואטסאפ עם הסיבה ומצב הזיכוי.';

  return (
    <div className="ci-inv" data-testid="chip-order-section">
      <div className="ci-invhead">
        <Ico size={15}><path d="M4 2v20l2-1 2 1 2-1 2 1 2-1 2 1 2-1 2 1V2l-2 1-2-1-2 1-2-1-2 1-2-1-2 1Z" /><path d="M16 8h-6a2 2 0 0 0 0 4h4a2 2 0 0 1 0 4H8" /></Ico>
        פירוט עסקה · הזמנה <span className="ci-num">{o.order_number}</span>
        {reception && <span className="ci-tag ci-brand" data-testid="chip-order-reception-tag">{CHIP_ORDER_RECEPTION_LABEL}</span>}
        {o.extra_of_order_number != null && (
          <span className="ci-tag ci-grey" data-testid="chip-order-extra-tag">
            {CHIP_ORDER_EXTRA_LABEL} להזמנה <span className="ci-num">{o.extra_of_order_number}</span>
          </span>
        )}
        {o.is_test && <span className="ci-tag ci-amber"><FlaskIco />{CHIP_ORDER_TEST_LABEL}</span>}
        {/* Only a code step that was skipped; NULL = the form had no code step (26/11/2026). */}
        {o.phone_verified === false && <span className="ci-tag ci-red">{CHIP_ORDER_PHONE_UNVERIFIED_LABEL}</span>}
      </div>
      <div className="ci-invwho">
        <div><span>שם המזמין</span><b>{o.full_name}</b></div>
        {/* A reception order may have no phone, email or address — nothing there is required. */}
        <div><span>טלפון נייד</span>{o.phone_e164 ? <b className="ci-num">{phoneView(o.phone_e164)}</b> : <b>—</b>}</div>
        <div><span>מייל</span>{o.email ? <b className="ci-num">{o.email}</b> : <b>—</b>}</div>
        <div><span>כתובת מגורים</span><b>{o.address ?? '—'}</b></div>
        <div>
          <span>סטטוס</span>
          <b>
            <span className={cn('ci-tag', stageTag)}>{chipOrderStageLabel(stage, linkedAll, ordered)}</span>
            {overdue && <> <span className="ci-tag ci-red">באיחור</span></>}
          </b>
        </div>
        <div>
          <span>יעד להכנה</span>
          <b className={cn('ci-num', overdue && 'ci-late')}>{o.due_at ? DUE.format(new Date(o.due_at)) : '—'}</b>
        </div>
        <div>
          <span>שויכו</span>
          <b data-testid="chip-order-progress"><span className="ci-num">{linked}</span> מתוך <span className="ci-num">{ordered}</span></b>
        </div>
        {/* The hand-over (25/11/2026): who collected, who handed over, where and when. */}
        {o.handed_over_via && (
          <>
            <div>
              <span>נאסף על ידי</span>
              <b data-testid="chip-order-collected-by">{o.collected_by_name ?? 'לא צוין'}</b>
            </div>
            <div>
              <span>נמסר על ידי</span>
              <b data-testid="chip-order-handed-by">
                {o.handed_over_by_name ?? '—'} · {o.handed_over_via === 'pickup' ? 'מסך מסירת הצ׳יפים' : 'ההנהלה'}
                {o.collected_at && <> · <span className="ci-num">{DUE.format(new Date(o.collected_at))}</span></>}
              </b>
            </div>
          </>
        )}
        {cancelled && (
          <>
            <div>
              <span>בוטלה על ידי</span>
              <b data-testid="chip-order-cancelled-by">
                {o.cancelled_by_name ?? '—'}
                {o.rejected_at && <> · <span className="ci-num">{DUE.format(new Date(o.rejected_at))}</span></>}
              </b>
            </div>
            <div>
              <span>סיבת הביטול</span>
              <b data-testid="chip-order-cancel-reason">{o.reject_reason ?? '—'}</b>
            </div>
          </>
        )}
      </div>

      {/* The payment — ONE block (26/11/2026). A card shows what the processor
          confirmed; a test order that never met a card stays "no charge". */}
      <div className="ci-invblk" data-testid="chip-order-payment">
        <div className="ci-invblkh"><PayIco />תשלום</div>
        <div className="ci-invwho">
          <div><span>אמצעי תשלום</span><b data-testid="chip-order-payment-method">{methodLabel}</b></div>
          <div>
            <span>סכום ששולם</span>
            {cardPaid || !o.is_test
              ? <b className="ci-num" data-testid="chip-order-paid-amount">{formatIlsAfter(paidAmount)}</b>
              : <b data-testid="chip-order-paid-amount">בדיקה, ללא חיוב</b>}
          </div>
          {cardPaid && (
            <>
              <div>
                <span>סביבה</span>
                <b data-testid="chip-order-card-payment">
                  <span className={cn('ci-tag', sandbox ? 'ci-amber' : 'ci-green')}>{sandbox ? 'סביבת בדיקות' : 'חיוב אמיתי'}</span>
                </b>
              </div>
              <div><span>כרטיס</span>{o.card_last4 ? <b className="ci-num">••••{o.card_last4}</b> : <b>—</b>}</div>
              <div><span>מספר אישור</span>{o.card_approval_number ? <b className="ci-num">{o.card_approval_number}</b> : <b>—</b>}</div>
              <div><span>מועד החיוב</span>{o.card_paid_at ? <b className="ci-num">{DUE.format(new Date(o.card_paid_at))}</b> : <b>—</b>}</div>
            </>
          )}
          {recordedBy && (
            <div>
              <span>התשלום נרשם על ידי</span>
              <b data-testid="chip-order-payment-by">
                {o.payment_recorded_by_name ?? '—'}
                {o.payment_recorded_at && <> · <span className="ci-num">{DUE.format(new Date(o.payment_recorded_at))}</span></>}
              </b>
            </div>
          )}
        </div>
      </div>

      {/* The refund (26/11/2026): its state, and everything known about it. */}
      {refundShown && (
        <div className="ci-invblk" data-testid="chip-order-refund">
          <div className="ci-invblkh">
            <RefundIco />זיכוי
            {o.refund_status && (
              <span className={cn('ci-tag', REFUND_TONE[o.refund_status])} data-testid="chip-order-refund-status">
                {CHIP_ORDER_REFUND_LABEL[o.refund_status]}
              </span>
            )}
          </div>
          {(o.refunded_amount != null || o.refunded_at || o.refunded_by_name || o.refund_via || o.refund_reason) && (
            <div className="ci-invwho">
              {o.refunded_amount != null && <div><span>סכום שזוכה</span><b className="ci-num">{formatIlsAfter(o.refunded_amount)}</b></div>}
              {o.refunded_at && <div><span>מועד הזיכוי</span><b className="ci-num">{DUE.format(new Date(o.refunded_at))}</b></div>}
              {o.refunded_by_name && <div><span>בוצע על ידי</span><b>{o.refunded_by_name}</b></div>}
              {o.refund_via && <div><span>דרך</span><b>{REFUND_VIA_LABEL[o.refund_via]}</b></div>}
              {o.refund_reason && <div><span>סיבת הזיכוי</span><b data-testid="chip-order-refund-reason">{o.refund_reason}</b></div>}
            </div>
          )}
          {o.refund_in_flight && (
            <p className="ci-reason ci-quiet" role="status" data-testid="chip-order-refund-in-flight">
              <AlertIco size={13} />
              <span>בקשת זיכוי נשלחה ל-PayPlus ולא נרשמה עליה תשובה. היא לא תישלח שוב — „ביטול וזיכוי” בודק ב-PayPlus מה קרה וממשיך משם.</span>
            </p>
          )}
          {/* PayPlus's own words — why the money has to go back by hand. */}
          {o.refund_note && o.refund_status !== 'refunded' && (
            <p className="ci-reason" role="status" data-testid="chip-order-refund-note">
              <AlertIco size={13} />
              <span>{o.refund_note}</span>
            </p>
          )}
        </div>
      )}

      {/* The order's Morning documents (26/11/2026). */}
      <div className="ci-invblk" data-testid="chip-order-documents">
        <div className="ci-invblkh"><DocIco />מסמכים</div>
        {o.is_test ? (
          <p className="ci-invnote">בהזמנת בדיקה לא מופק מסמך</p>
        ) : documents.length === 0 ? (
          <p className="ci-invnote">לא הופקו מסמכים להזמנה</p>
        ) : (
          <div className="ci-docs">
            {documents.map((d, i) => {
              const state = chipOrderDocState(d, win.documents_connected);
              return (
                <div key={i} className="ci-doc" data-testid="chip-order-document">
                  <b>{d.kind === 'credit' ? 'זיכוי' : 'חשבונית'}</b>
                  <span className="ci-num">{formatIlsAfter(d.amount)}</span>
                  {state.kind === 'issued' ? (
                    state.url ? (
                      <a href={state.url} target="_blank" rel="noopener noreferrer" className="ci-doclink" title="פתיחת המסמך בלשונית חדשה"
                        data-testid="chip-order-document-link">
                        <span className="ci-num">{state.number ?? 'הופק'}</span>
                        <LinkIco />
                      </a>
                    ) : (
                      <span className="ci-docstate"><span className="ci-num">{state.number ?? 'הופק'}</span></span>
                    )
                  ) : state.kind === 'none' ? null : (
                    <span className={cn('ci-docstate', state.kind === 'failed' && 'ci-fail')}>{state.text}</span>
                  )}
                  {d.status === 'issued' && (d.numbers?.length ?? 0) > 1 && (
                    <small className="ci-docmail">מסמכים <span className="ci-num">{d.numbers!.join(', ')}</span></small>
                  )}
                  {d.status === 'issued' && d.email_status && (
                    <small className="ci-docmail" data-testid="chip-order-document-email">
                      {d.email_status === 'sent'
                        ? <>מורנינג שלח למייל <span className="ci-num" dir="ltr">{d.email_to}</span></>
                        : 'לא נשלח במייל — אין מייל בהזמנה'}
                    </small>
                  )}
                  {d.status === 'failed' && d.last_error && <small className="ci-docerr">{d.last_error}</small>}
                </div>
              );
            })}
          </div>
        )}
        {failedDocuments && canAdminOrders && (
          <div className="ci-docact">
            <button type="button" className="ci-btn ci-line" disabled={disabled || busy !== null} onClick={() => void retryDocuments()}
              data-testid="chip-order-documents-retry">
              {busy === 'retry' ? <Loader2 className="ci-spin h-3.5 w-3.5" /> : <DocIco />}
              הפק חשבונית שוב
            </button>
          </div>
        )}
      </div>

      <div className="ci-invapts">
        {win.items.map((i) => {
          const people = win.holders.filter((h) => h.item_id === i.id && h.source !== 'staff');
          const r = roleOf(people.map((h) => h.role));
          const phones = [...new Set(people.map((h) => phoneView(h.phone)).filter(Boolean))];
          const emails = [...new Set(people.map((h) => h.email ?? '').filter(Boolean))];
          const contact = [...phones, ...emails];
          return (
            <div key={i.id} className="ci-invapt">
              <span className="ci-aptno ci-num">{i.apartment_number}</span>
              <div className="ci-who">
                <b>{people.map((h) => h.full_name).join(', ') || o.full_name}</b>
                {/* Each phone / email is isolated LTR; the line itself runs right to left. */}
                <small title={contact.join(' · ')}>
                  {contact.map((c, ci) => <span key={c}>{ci > 0 && ' · '}<span className="ci-num">{c}</span></span>)}
                </small>
              </div>
              <span className={cn('ci-role', r.tone)}>{r.label}</span>
              <span className="ci-aqty"><b className="ci-num">{i.chips_count}</b> כרטיסים</span>
              <span className="ci-aprice ci-num">{formatIlsAfter(i.line_total)}</span>
            </div>
          );
        })}
      </div>
      {first && (base > 0 || above > 0) && (
        <div className="ci-invlines">
          {tiered ? (
            <>
              {base > 0 && (
                <div>
                  <span>{first.threshold} הכרטיסים הראשונים לכל דירה — <b className="ci-num">{base}×{formatIlsAfter(first.unit_price)}</b></span>
                  <b className="ci-num">{formatIlsAfter(baseCents / 100)}</b>
                </div>
              )}
              <div>
                <span>מהכרטיס ה-{first.threshold + 1} ואילך — <b className="ci-num">{above}×{formatIlsAfter(first.price_above)}</b></span>
                <b className="ci-num">{formatIlsAfter(aboveCents / 100)}</b>
              </div>
            </>
          ) : (
            <div>
              <span>כרטיס בקרת כניסה — <b className="ci-num">{base + above}×{formatIlsAfter(first.unit_price)}</b></span>
              <b className="ci-num">{formatIlsAfter((baseCents + aboveCents) / 100)}</b>
            </div>
          )}
        </div>
      )}
      <div className="ci-invtotal">
        <span>סה&quot;כ לתשלום<small>{ordered} כרטיסים להנפקה · {win.items.length === 1 ? 'דירה אחת' : `${win.items.length} דירות`}</small></span>
        <b className="ci-num">{formatIlsAfter(o.total)}</b>
      </div>
      {/* Extra chips that were added to this order and paid at the reception —
          each a reception order of its own; this order's total is unchanged. */}
      {(win.extra_orders ?? []).length > 0 && (
        <div className="ci-invlines" data-testid="chip-order-extra-orders">
          {win.extra_orders.map((x) => (
            <div key={x.order_number}>
              <span>
                {CHIP_ORDER_EXTRA_LABEL} ששולמו בקבלה — הזמנת קבלה <b className="ci-num">{x.order_number}</b> · <b className="ci-num">{x.chips_count}</b> {x.chips_count === 1 ? 'צ׳יפ' : 'צ׳יפים'}
                {x.status === 'rejected' && <> · <span className="ci-tag ci-red">{CHIP_ORDER_CANCELLED_LABEL}</span></>}
              </span>
              <b className="ci-num">{formatIlsAfter(x.total)}</b>
            </div>
          ))}
        </div>
      )}
      {/* PayPlus showed the charge cancelled / refunded after a callback
          (27/11/2026): nothing was recorded and no Morning document went out —
          "ביטול וזיכוי" finishes it (an admin); everyone who opens the order sees it. */}
      {reversal && (
        <div className="ci-reason ci-stop" role="alert" data-testid="chip-order-payplus-reversal">
          <AlertIco size={13} />
          <span>
            <b>{PAYPLUS_REVERSAL_LABEL}</b>
            {' — '}{PAYPLUS_REVERSAL_TEXT[reversal]}
            {canAdminOrders ? ` ${PAYPLUS_REVERSAL_NEXT[reversal]}` : ' מנהל מערכת משלים ב„ביטול וזיכוי”.'}
          </span>
        </div>
      )}
      {canEditOrders && (
        <>
          <div className="ci-oact" data-testid="chip-order-actions">
            {/* No "בטיפול" here, although the reference draws one: the system
                has no such status (see the note at the top of the file). */}
            {assigning ? (
              <button type="button" className="ci-btn ci-primary" disabled={disabled || busy !== null || !readyAction.can || refundPending}
                title={refundPending ? PENDING_REFUND : readyAction.reason ?? undefined} onClick={readyAction.run}>
                {readyAction.busy ? <Loader2 className="ci-spin h-3.5 w-3.5" /> : <CheckIco />}
                מוכן לאיסוף
              </button>
            ) : (
              <button type="button" className={cn('ci-btn ci-line', ready && 'ci-cur')} disabled
                aria-current={ready ? 'step' : undefined}
                title={ready ? 'ההזמנה מוכנה לאיסוף — זה השלב שלה כרגע' : collected ? 'ההזמנה כבר נאספה' : 'ההזמנה נדחתה'}>
                <CheckIco />
                מוכן לאיסוף
              </button>
            )}
            {/* The filled button is always the NEXT step: "מוכן לאיסוף" for a
                paid order (as the reference draws it), "נאסף" once it is ready. */}
            <button type="button" className={cn('ci-btn', ready ? 'ci-primary' : 'ci-line', collected && 'ci-cur')}
              disabled={disabled || busy !== null || !ready || refundPending}
              aria-current={collected ? 'step' : undefined}
              title={refundPending ? PENDING_REFUND : ready ? undefined : collected ? 'ההזמנה נאספה — זה השלב שלה כרגע' : rejected ? 'ההזמנה נדחתה' : 'אפשר לסמן „נאסף” רק אחרי „מוכן לאיסוף”'}
              onClick={() => { setCollector(null); setModal('collect', true); }}>
              {busy === 'collected' ? <Loader2 className="ci-spin h-3.5 w-3.5" /> : <CheckAllIco />}
              נאסף
            </button>
            {/* A reception order is never "rejected": "ביטול וזיכוי" (admins) cancels and refunds it. */}
            <button type="button" className={cn('ci-btn ci-line', rejected && 'ci-cur')}
              disabled={disabled || busy !== null || !assigning || reception || refundPending}
              aria-current={rejected ? 'step' : undefined}
              title={refundPending ? PENDING_REFUND : cancelled ? 'הזמנת הקבלה בוטלה — זה השלב שלה כרגע' : reception ? 'הזמנת קבלה מבטלים ב„ביטול וזיכוי”' : assigning ? undefined : rejected ? 'ההזמנה נדחתה — זה השלב שלה כרגע' : collected ? 'ההזמנה כבר נאספה' : 'אפשר לדחות הזמנה רק לפני „מוכן לאיסוף”'}
              onClick={() => setModal('reject', true)}>
              {cancelled ? CHIP_ORDER_CANCELLED_LABEL : 'דחה'}
            </button>
            {/* "ביטול וזיכוי" (27/11/2026) — the one way back, admin and super
                admin: the refund (PayPlus is asked first; never a second
                refund), the credit document, then the order cancelled and its
                chips disabled. A reception order: collected, or paid by card
                with its chips never saved; a web order the card paid. */}
            {cancellable && canAdminOrders && (
              <button type="button" className="ci-btn ci-danger" disabled={disabled || busy !== null}
                onClick={() => setModal('cancel', true)} data-testid="chip-order-cancel-reception">
                <TrashIco size={13} />
                {o.cancel_failed_step ? 'המשך ביטול וזיכוי' : RECEPTION_CANCEL_LABEL}
              </button>
            )}
            {o.is_test && (
              <button type="button" className="ci-btn ci-danger" disabled={disabled || busy !== null} onClick={() => setModal('delete', true)}
                data-testid="chip-order-delete-test">
                <TrashIco size={13} />
                מחק הזמנת בדיקה
              </button>
            )}
          </div>
          {o.cancel_failed_step && !o.cancel_completed && (reception ? !rejected : true) && (
            <p className="ci-reason ci-stop" role="status" data-testid="chip-order-cancel-stopped">
              <AlertIco size={13} />
              <span>{receptionCancelStoppedText(o.cancel_failed_step)}{o.cancel_error ? ` — ${o.cancel_error}` : ''}</span>
            </p>
          )}
          {readyNote && (
            <p className={cn('ci-reason', readyNote.quiet && 'ci-quiet')} role="status" data-testid="chip-order-ready-reason">
              <AlertIco size={13} />
              <span>{readyNote.text}</span>
            </p>
          )}
          {win.items.length > 1 && (
            <p className="ci-actnote">„מוכן לאיסוף”, „נאסף” ו„דחה” חלים על ההזמנה כולה — כל הדירות שבה.</p>
          )}
        </>
      )}

      <AlertDialog open={rejectOpen} onOpenChange={(v) => { if (!busy) setModal('reject', v); }}>
        <AlertDialogContent dir="rtl">
          <AlertDialogHeader>
            <AlertDialogTitle>לדחות את הזמנה {o.order_number}?</AlertDialogTitle>
            <AlertDialogDescription>{rejectText}</AlertDialogDescription>
          </AlertDialogHeader>
          <Textarea
            value={rejectReason}
            onChange={(e) => setRejectReason(e.target.value)}
            placeholder="סיבת הדחייה (תישלח למזמין)"
            maxLength={500}
            className="min-h-[96px] px-3 py-2"
            aria-label="סיבת הדחייה"
          />
          <AlertDialogFooter>
            <AlertDialogCancel disabled={busy !== null} className="h-11 px-4">ביטול</AlertDialogCancel>
            <Button
              type="button"
              disabled={busy !== null || rejectReason.trim().length < 2}
              onClick={async () => {
                const ok = await act('reject', () => postJson(`/api/chip-orders/${o.id}/reject`, { reason: rejectReason.trim() }), afterReject);
                if (ok) { setModal('reject', false); setRejectReason(''); }
              }}
              className="h-11 gap-2 bg-destructive px-4 text-white hover:bg-destructive/90"
            >
              {busy === 'reject' && <Loader2 className="h-4 w-4 animate-spin" />}
              {cardPaid ? 'דחה והחזר תשלום' : 'דחה'}
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={collectOpen} onOpenChange={(v) => { if (!busy) setModal('collect', v); }}>
        <AlertDialogContent dir="rtl" data-testid="chip-order-collect-confirm">
          <AlertDialogHeader>
            <AlertDialogTitle>לסמן את הזמנה {o.order_number} כנאספה?</AlertDialogTitle>
            <AlertDialogDescription>
              ההזמנה תצא מרשימת ההזמנות הפתוחות. לא נשלחת הודעה למזמין.
              {win.items.length > 1 && ' הסימון חל על ההזמנה כולה — כל הדירות שבה.'}
            </AlertDialogDescription>
          </AlertDialogHeader>
          {collectors.length > 0 && (
            <div className="flex flex-col gap-2">
              <span className="text-[13px] font-bold">מי אסף את הצ׳יפים? <span className="font-semibold text-muted-foreground">(לא חובה)</span></span>
              <CollectorPicker
                people={collectors}
                value={collector}
                onChange={setCollector}
                disabled={busy !== null}
                optional
                showApartment={win.items.length > 1}
                testId="chip-order-collect-option"
              />
            </div>
          )}
          <AlertDialogFooter>
            <AlertDialogCancel disabled={busy !== null} className="h-11 px-4">ביטול</AlertDialogCancel>
            <Button
              type="button"
              disabled={busy !== null}
              onClick={async () => {
                const ok = await act(
                  'collected',
                  () => postJson(`/api/chip-orders/${o.id}/collected`, collector ? { person: collector } : undefined),
                  'סומן כנאסף',
                );
                if (ok) setModal('collect', false);
              }}
              className="h-11 gap-2 px-4"
            >
              {busy === 'collected' && <Loader2 className="h-4 w-4 animate-spin" />}
              סמן כנאסף
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {canAdminOrders && (reception || cardPaid) && (
        <ReceptionCancelDialog
          orderId={o.id}
          open={cancelOpen}
          onOpenChange={(v) => setModal('cancel', v)}
          onChanged={(result) => (result === 'done' ? onGone() : onReload())}
        />
      )}

      <AlertDialog open={deleteOpen} onOpenChange={(v) => { if (!busy) setModal('delete', v); }}>
        <AlertDialogContent dir="rtl">
          <AlertDialogHeader>
            <AlertDialogTitle>למחוק את הזמנת הבדיקה {o.order_number}?</AlertDialogTitle>
            <AlertDialogDescription>
              הצ׳יפים הפעילים שהונפקו להזמנה יושבתו קודם (הם לא נמחקים, ונשארים במודול הצ׳יפים בלי הקישור להזמנה). אחר כך ההזמנה, הדירות שלה, ההודעות וקובצי החוזה יימחקו לצמיתות.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={busy !== null} className="h-11 px-4">ביטול</AlertDialogCancel>
            <Button
              type="button"
              disabled={busy !== null}
              onClick={async () => {
                const ok = await act('delete', () => postJson(`/api/chip-orders/${o.id}`, undefined, 'DELETE'), 'הזמנת הבדיקה נמחקה');
                if (ok) setModal('delete', false);
              }}
              className="h-11 gap-2 bg-destructive px-4 text-white hover:bg-destructive/90"
            >
              {busy === 'delete' && <Loader2 className="h-4 w-4 animate-spin" />}
              מחק הזמנת בדיקה
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
