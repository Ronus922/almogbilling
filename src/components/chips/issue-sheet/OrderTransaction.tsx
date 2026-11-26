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
//   And one more button: "זיכוי" — admin and super admin only — a full refund
//   of a WEB order the card paid, in any status, with a required reason
//   (POST /api/chip-orders/[id]/refund). "דחה" of a card order refunds it
//   through PayPlus too, and "בטל הזמנת קבלה" says how the money goes back.

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
import { CollectorPicker, type CollectorOption } from '../CollectorPicker';
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
  /** "בטל הזמנת קבלה": how it was paid, and the card refund (null = not a card). */
  payment_method?: string | null;
  refund?: { kind: 'refunded'; full: boolean } | { kind: 'manual_required' | 'unknown'; note: string } | null;
  /** "זיכוי". */
  kind?: 'refunded' | 'manual_required' | 'unknown';
  full?: boolean;
  closed?: boolean;
  chipsDisabled?: number;
  note?: string;
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
  admin: 'זיכוי',
  reject: 'דחייה',
  reception_cancel: 'ביטול הזמנת קבלה',
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
  /** Admin / super admin, by role — "בטל הזמנת קבלה", "זיכוי" and "הפק
   *  חשבונית שוב" (each route asks again: requireAdmin). */
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
  // "בטל הזמנת קבלה": a reason is required.
  const [cancelOpen, setCancelOpen] = useState(false);
  const [cancelReason, setCancelReason] = useState('');
  // "זיכוי": a reason is required.
  const [refundOpen, setRefundOpen] = useState(false);
  const [refundReason, setRefundReason] = useState('');

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
  // The order has a Morning invoice — a cancellation credits it.
  const hasInvoice = (o.documents ?? []).some((d) => d.kind === 'invoice');
  // "זיכוי" (26/11/2026): a web order the card paid, not refunded yet and with
  // no refund on its way — in any status; a reception card order only once it
  // was cancelled (its refund then failed). Admin and super admin only.
  const canRefund = canAdminOrders && (!reception || rejected) && cardPaid && !o.refunded_at && !o.refund_in_flight;
  // A "זיכוי" waiting for PayPlus's answer (it may have gone through): the
  // order is not moved on — no "מוכן לאיסוף", "נאסף" or "דחה" — until it is
  // settled (the refund block says so).
  const refundPending = o.refund_in_flight === true;
  const PENDING_REFUND = 'בקשת זיכוי ממתינה לתשובה מ-PayPlus';

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

  function setModal(kind: 'reject' | 'delete' | 'collect' | 'cancel' | 'refund', open: boolean) {
    if (kind === 'reject') setRejectOpen(open);
    else if (kind === 'delete') setDeleteOpen(open);
    else if (kind === 'collect') setCollectOpen(open);
    else if (kind === 'refund') setRefundOpen(open);
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

  /** "נאסף", "דחה", "בטל הזמנת קבלה" and "מחק הזמנת בדיקה" — each takes the
   *  order out of the open list, so the window closes after it. `ok` is the
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
    if (data.refund_status === 'manual_required') toast.warning('ההזמנה נדחתה — הזיכוי לא בוצע אוטומטית', { description: detail });
    else toast.success('ההזמנה נדחתה', detail ? { description: detail } : undefined);
  }

  /** "בטל הזמנת קבלה" — the toast says where the money stands. */
  function afterCancel(data: ActionAnswer) {
    const title = 'הזמנת הקבלה בוטלה — הצ׳יפים שלה הושבתו';
    const refund = data.refund ?? null;
    if (refund?.kind === 'refunded') {
      toast.success(title, { description: refund.full ? 'זוכה במלואו לכרטיס דרך PayPlus' : 'זוכה חלקית לכרטיס דרך PayPlus' });
    } else if (refund) {
      toast.warning('הזמנת הקבלה בוטלה, אבל הזיכוי בכרטיס לא בוצע', { description: refund.note });
    } else {
      const method = data.payment_method ?? o.payment_method;
      const by = method === 'cash' ? 'במזומן' : method === 'bank_transfer' ? 'בהעברה' : null;
      toast.success(title, {
        description: by
          ? `את הכסף מחזירים ידנית ${by}${hasInvoice ? '; חשבונית זיכוי תופק במורנינג' : ''}`
          : 'את הכסף — אם שולם — מחזירים ידנית, מחוץ למערכת',
      });
    }
  }

  /** "זיכוי" after the confirmation. Refunded → the window closes (the row
   *  behind it shows "זוכה"). PayPlus refused, or did not answer → the order
   *  says so: the window stays open, loaded again, with PayPlus's words. */
  async function runRefund() {
    setBusy('refund');
    let reload = false;
    try {
      const res = await fetch(`/api/chip-orders/${o.id}/refund`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ reason: refundReason.trim() }),
      });
      const data = (await res.json().catch(() => ({}))) as ActionAnswer;
      if (res.ok && data.ok) {
        const parts = [`${formatIlsAfter(paidAmount)} הוחזרו לכרטיס${sandbox ? ' (סביבת בדיקות)' : ''}`];
        if (data.full === false) parts.push('זיכוי חלקי');
        if (data.chipsDisabled) parts.push(data.chipsDisabled === 1 ? 'צ׳יפ אחד הושבת' : `${data.chipsDisabled} צ׳יפים הושבתו`);
        if (data.closed) parts.push('ההזמנה נסגרה');
        toast.success(`הזמנה ${o.order_number} זוכתה`, { description: parts.join(' · ') });
        setModal('refund', false);
        setRefundReason('');
        onGone();
        return;
      }
      // A reason the server would not take (400) keeps the dialog open; any
      // other answer means the order moved — PayPlus refused, did not answer,
      // or the order was refunded meanwhile — and the window shows it.
      if (res.status === 400) {
        toast.error(data.error ?? 'הזיכוי לא נשלח');
        return;
      }
      toast.error(data.kind === 'unknown' ? 'אין תשובה מ-PayPlus על הזיכוי' : 'הזיכוי לא בוצע', {
        description: data.note ?? data.error ?? undefined,
      });
      reload = true;
    } catch {
      toast.error('הזיכוי נכשל — בדקו את מצב ההזמנה לפני ניסיון נוסף');
      reload = true;
    } finally {
      setBusy(null);
    }
    if (reload) {
      setModal('refund', false);
      onReload();
    }
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

  const cancelMoney = cardPaid
    ? 'יבוצע זיכוי מלא לכרטיס דרך PayPlus.'
    : o.payment_method === 'cash' || o.payment_method === 'bank_transfer'
      ? `את הכסף מחזירים ידנית ${o.payment_method === 'cash' ? 'במזומן' : 'בהעברה'}${hasInvoice ? '; תופק חשבונית זיכוי במורנינג' : ''}.`
      : 'החזר הכסף — אם שולם — נעשה ידנית, מחוץ למערכת.';

  const refundText = sandbox || o.is_test
    ? `יבוצע זיכוי מלא של ${formatIlsAfter(paidAmount)} לכרטיס הבדיקה, בסביבת הבדיקות של PayPlus (אין כסף אמיתי), והצ׳יפים הפעילים של ההזמנה יושבתו. בהזמנת בדיקה לא מופקת חשבונית זיכוי. הפעולה אינה הפיכה.`
    : `יבוצע זיכוי מלא של ${formatIlsAfter(paidAmount)} לכרטיס דרך PayPlus, הצ׳יפים הפעילים של ההזמנה יושבתו, ותופק חשבונית זיכוי. הפעולה אינה הפיכה.`;
  const refundCloses = o.status === 'paid' || o.status === 'approved' || o.status === 'ready';

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
              <span>בקשת זיכוי נשלחה ל-PayPlus — ממתינה לתשובה</span>
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
            {/* A reception order is never "rejected": "בטל הזמנת קבלה" (admins) cancels and refunds it. */}
            <button type="button" className={cn('ci-btn ci-line', rejected && 'ci-cur')}
              disabled={disabled || busy !== null || !assigning || reception || refundPending}
              aria-current={rejected ? 'step' : undefined}
              title={refundPending ? PENDING_REFUND : cancelled ? 'הזמנת הקבלה בוטלה — זה השלב שלה כרגע' : reception ? 'הזמנת קבלה מבטלים ב„בטל הזמנת קבלה”' : assigning ? undefined : rejected ? 'ההזמנה נדחתה — זה השלב שלה כרגע' : collected ? 'ההזמנה כבר נאספה' : 'אפשר לדחות הזמנה רק לפני „מוכן לאיסוף”'}
              onClick={() => setModal('reject', true)}>
              {cancelled ? CHIP_ORDER_CANCELLED_LABEL : 'דחה'}
            </button>
            {/* "זיכוי" (26/11/2026): a full refund of a web order the card paid,
                in any status. Admin and super admin. */}
            {canRefund && (
              <button type="button" className="ci-btn ci-danger" disabled={disabled || busy !== null}
                onClick={() => { setRefundReason(''); setModal('refund', true); }} data-testid="chip-order-refund-button">
                <RefundIco size={13} />
                זיכוי
              </button>
            )}
            {/* A reception order is real and collected the moment it is made:
                cancelling it is its only way back. Admin and super admin. Also
                a reception order the card PAID whose chips were never saved
                (the window was closed after the payment): cancel = refund. */}
            {reception && (collected || (o.status === 'paid' && cardPaid)) && canAdminOrders && (
              <button type="button" className="ci-btn ci-danger" disabled={disabled || busy !== null}
                onClick={() => { setCancelReason(''); setModal('cancel', true); }} data-testid="chip-order-cancel-reception">
                <TrashIco size={13} />
                בטל הזמנת קבלה
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

      <AlertDialog open={cancelOpen} onOpenChange={(v) => { if (!busy) setModal('cancel', v); }}>
        <AlertDialogContent dir="rtl" className="p-6" data-testid="chip-order-cancel-confirm">
          <AlertDialogHeader>
            <AlertDialogTitle>לבטל את הזמנת הקבלה {o.order_number}?</AlertDialogTitle>
            <AlertDialogDescription>
              ההזמנה תסומן „{CHIP_ORDER_CANCELLED_LABEL}” ותישאר בטבלה. הצ׳יפים שלה יושבתו (הם לא נמחקים, ואפשר להחזיר כל אחד לפעיל). {cancelMoney} לא נשלחת הודעה ללקוח. אי אפשר לבטל את הביטול.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <Textarea
            value={cancelReason}
            onChange={(e) => setCancelReason(e.target.value)}
            placeholder="סיבת הביטול (חובה)"
            maxLength={500}
            className="min-h-[96px] px-3 py-2"
            aria-label="סיבת הביטול"
          />
          <AlertDialogFooter>
            <AlertDialogCancel disabled={busy !== null} className="h-11 px-4">חזרה</AlertDialogCancel>
            <Button
              type="button"
              disabled={busy !== null || cancelReason.trim().length < 2}
              onClick={async () => {
                const ok = await act('cancel', () => postJson(`/api/chip-orders/${o.id}/cancel`, { reason: cancelReason.trim() }), afterCancel);
                if (ok) { setModal('cancel', false); setCancelReason(''); }
              }}
              className="h-11 gap-2 bg-destructive px-4 text-white hover:bg-destructive/90"
            >
              {busy === 'cancel' && <Loader2 className="h-4 w-4 animate-spin" />}
              בטל הזמנת קבלה
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={refundOpen} onOpenChange={(v) => { if (!busy) setModal('refund', v); }}>
        <AlertDialogContent dir="rtl" className="p-6" data-testid="chip-order-refund-confirm">
          <AlertDialogHeader>
            <AlertDialogTitle>לזכות את הזמנה {o.order_number}?</AlertDialogTitle>
            <AlertDialogDescription>
              {refundText}
              {refundCloses && ' ההזמנה עוד פתוחה — היא תיסגר כ„נדחה”, עם סיבת הזיכוי.'}
              {' '}המזמין יקבל מייל ווואטסאפ על הזיכוי (הסיבה לא נשלחת אליו).
            </AlertDialogDescription>
          </AlertDialogHeader>
          <Textarea
            value={refundReason}
            onChange={(e) => setRefundReason(e.target.value)}
            placeholder="סיבת הזיכוי (חובה)"
            maxLength={500}
            className="min-h-[96px] px-3 py-2"
            aria-label="סיבת הזיכוי"
          />
          <AlertDialogFooter>
            <AlertDialogCancel disabled={busy !== null} className="h-11 px-4">חזרה</AlertDialogCancel>
            <Button
              type="button"
              disabled={busy !== null || refundReason.trim().length < 2}
              onClick={() => void runRefund()}
              className="h-11 gap-2 bg-destructive px-4 text-white hover:bg-destructive/90"
              data-testid="chip-order-refund-submit"
            >
              {busy === 'refund' && <Loader2 className="h-4 w-4 animate-spin" />}
              בצע זיכוי
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

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
