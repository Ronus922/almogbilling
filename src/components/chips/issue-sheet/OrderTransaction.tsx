'use client';

// "פירוט עסקה" of the issue window (v2 design of 24/11/2026, `.inv` of
// ref/chip-order/chip-issue-admin-v2.html): the order's number and tags, who
// ordered (three columns), status, what was paid, the due date, "שויכו X מתוך
// Y", one line per apartment (its people, role, quantity, price), the price
// lines from the order's own snapshot, the total — and the row of status
// buttons: "מוכן לאיסוף", "נאסף", "דחה" and, at the far end, "מחק הזמנת בדיקה"
// (test orders only; it disables the order's chips first).
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
  CHIP_ORDER_CANCELLED_LABEL, CHIP_ORDER_PHONE_UNVERIFIED_LABEL, CHIP_ORDER_TEST_LABEL, chipOrderStage, chipOrderStageLabel,
  formatIlsAfter, isChipOrderOverdue, type ChipOrderWindow,
} from '@/lib/chipOrders/model';
import { PICKUP_ORDERER_KEY } from '@/lib/chipOrders/pickup';
import { CHIP_ORDER_EXTRA_LABEL, CHIP_ORDER_RECEPTION_LABEL, RECEPTION_PAYMENT_LABEL } from '@/lib/chipOrders/reception';
import { e164ToLocal } from '@/lib/portal/phone';
import { CollectorPicker, type CollectorOption } from '../CollectorPicker';
import { AlertIco, CheckIco, Ico, ROLE_SHORT, TrashIco, roleTone } from './parts';

const DUE = new Intl.DateTimeFormat('he-IL', {
  timeZone: 'Asia/Jerusalem', day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
});

const phoneView = (p: string | null) => (p ? (p.startsWith('+972') ? e164ToLocal(p) : p) : '');

async function postJson(url: string, body?: unknown, method = 'POST') {
  const res = await fetch(url, {
    method,
    credentials: 'include',
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = (await res.json().catch(() => ({}))) as { error?: string; refund_label?: string; refund_note?: string | null };
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

const CheckAllIco = () => <Ico size={13} sw={2}><path d="M20 7 10 17l-6-6" /><path d="M22 11 12 21l-2-2" /></Ico>;
const FlaskIco = () => <Ico size={11} sw={2.2} join={false}><path d="M10 2v6L4.5 18a2 2 0 0 0 1.8 3h11.4a2 2 0 0 0 1.8-3L14 8V2M8.5 2h7" /></Ico>;

export function OrderTransaction({
  win, readyAction, canEditOrders, canCancelReception = false, disabled, onGone, onModalChange,
}: {
  win: ChipOrderWindow;
  /** "מוכן לאיסוף" of an order that is being assigned: whether it may be
   *  pressed now, why not (`reason`, shown under the buttons), and the click —
   *  which saves the window first. */
  readyAction: { can: boolean; busy: boolean; reason: string | null; run: () => void };
  /** chips_orders_manage:edit — the order's buttons. */
  canEditOrders: boolean;
  /** Admin / super admin — "בטל הזמנת קבלה" (the server asks again, by role). */
  canCancelReception?: boolean;
  disabled: boolean;
  /** The order left the open list (collected / rejected / deleted). */
  onGone: () => void;
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
   *  open list, so the window closes after it. */
  async function act(key: string, run: () => Promise<{ refund_label?: string; refund_note?: string | null }>, okMsg: string): Promise<boolean> {
    setBusy(key);
    try {
      const data = await run();
      toast.success(okMsg, data.refund_label ? { description: `זיכוי: ${data.refund_label}${data.refund_note ? ` — ${data.refund_note}` : ''}` } : undefined);
      onGone();
      return true;
    } catch (e) {
      toast.error((e as Error).message);
      return false;
    } finally {
      setBusy(null);
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
        {!o.phone_verified && <span className="ci-tag ci-red">{CHIP_ORDER_PHONE_UNVERIFIED_LABEL}</span>}
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
        {/* The amount actually paid. A card payment shows what the processor
            confirmed; a test order that never met a card stays "no charge". */}
        <div>
          <span>סכום ששולם</span>
          {cardPaid
            ? <b data-testid="chip-order-paid-amount"><span className="ci-num">{formatIlsAfter(o.card_paid_amount ?? o.total)}</span>{o.card_env === 'sandbox' && <> · כרטיס בדיקה, ללא חיוב אמיתי</>}</b>
            : o.is_test ? <b data-testid="chip-order-paid-amount">בדיקה, ללא חיוב</b> : <b className="ci-num" data-testid="chip-order-paid-amount">{formatIlsAfter(o.total)}</b>}
        </div>
        {cardPaid && (
          <div>
            <span>סטטוס תשלום</span>
            <b data-testid="chip-order-card-payment">
              <span className={cn('ci-tag', o.card_env === 'sandbox' ? 'ci-amber' : 'ci-green')}>
                {o.card_env === 'sandbox' ? 'שולם באשראי · סביבת בדיקות' : 'שולם באשראי'}
              </span>
              {o.card_last4 && <> · כרטיס <span className="ci-num">••••{o.card_last4}</span></>}
              {o.card_approval_number && <> · אישור <span className="ci-num">{o.card_approval_number}</span></>}
              {o.card_paid_at && <> · <span className="ci-num">{DUE.format(new Date(o.card_paid_at))}</span></>}
            </b>
          </div>
        )}
        <div>
          <span>יעד להכנה</span>
          <b className={cn('ci-num', overdue && 'ci-late')}>{o.due_at ? DUE.format(new Date(o.due_at)) : '—'}</b>
        </div>
        <div>
          <span>שויכו</span>
          <b data-testid="chip-order-progress"><span className="ci-num">{linked}</span> מתוך <span className="ci-num">{ordered}</span></b>
        </div>
        {reception && (
          <>
            <div>
              <span>אמצעי תשלום</span>
              <b data-testid="chip-order-payment-method">{o.payment_method === 'cash_transfer' ? RECEPTION_PAYMENT_LABEL.cash_transfer : o.payment_method ?? '—'}</b>
            </div>
            <div>
              <span>התשלום נרשם על ידי</span>
              <b data-testid="chip-order-payment-by">
                {o.payment_recorded_by_name ?? '—'}
                {o.payment_recorded_at && <> · <span className="ci-num">{DUE.format(new Date(o.payment_recorded_at))}</span></>}
              </b>
            </div>
          </>
        )}
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
              <button type="button" className="ci-btn ci-primary" disabled={disabled || busy !== null || !readyAction.can}
                title={readyAction.reason ?? undefined} onClick={readyAction.run}>
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
              disabled={disabled || busy !== null || !ready}
              aria-current={collected ? 'step' : undefined}
              title={ready ? undefined : collected ? 'ההזמנה נאספה — זה השלב שלה כרגע' : rejected ? 'ההזמנה נדחתה' : 'אפשר לסמן „נאסף” רק אחרי „מוכן לאיסוף”'}
              onClick={() => { setCollector(null); setModal('collect', true); }}>
              {busy === 'collected' ? <Loader2 className="ci-spin h-3.5 w-3.5" /> : <CheckAllIco />}
              נאסף
            </button>
            <button type="button" className={cn('ci-btn ci-line', rejected && 'ci-cur')}
              disabled={disabled || busy !== null || !assigning}
              aria-current={rejected ? 'step' : undefined}
              title={assigning ? undefined : cancelled ? 'הזמנת הקבלה בוטלה — זה השלב שלה כרגע' : rejected ? 'ההזמנה נדחתה — זה השלב שלה כרגע' : collected ? 'ההזמנה כבר נאספה' : 'אפשר לדחות הזמנה רק לפני „מוכן לאיסוף”'}
              onClick={() => setModal('reject', true)}>
              {cancelled ? CHIP_ORDER_CANCELLED_LABEL : 'דחה'}
            </button>
            {/* A reception order is real and collected the moment it is made:
                cancelling it is its only way back. Admin and super admin. */}
            {reception && collected && canCancelReception && (
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
            <AlertDialogDescription>
              {o.is_test
                ? 'הזמנת בדיקה: היא תסומן „נדחה” בלי פנייה ל-Grow (לא היה חיוב — הזיכוי „לא נדרש (בדיקה)”). המזמין יקבל מייל ווואטסאפ עם הסיבה.'
                : 'ההזמנה תסומן „נדחה” ויתבקש זיכוי מלא מ-Grow. המזמין יקבל מייל ווואטסאפ עם הסיבה ומצב הזיכוי.'}
            </AlertDialogDescription>
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
                const ok = await act('reject', () => postJson(`/api/chip-orders/${o.id}/reject`, { reason: rejectReason.trim() }), 'ההזמנה נדחתה');
                if (ok) { setModal('reject', false); setRejectReason(''); }
              }}
              className="h-11 gap-2 bg-destructive px-4 text-white hover:bg-destructive/90"
            >
              {busy === 'reject' && <Loader2 className="h-4 w-4 animate-spin" />}
              {o.is_test ? 'דחה' : 'דחה והחזר תשלום'}
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
              ההזמנה תסומן „{CHIP_ORDER_CANCELLED_LABEL}” ותישאר בטבלה. הצ׳יפים שלה יושבתו (הם לא נמחקים, ואפשר להחזיר כל אחד לפעיל). לא נשלחת הודעה ללקוח, והחזר הכסף — אם שולם — נעשה מחוץ למערכת. אי אפשר לבטל את הביטול.
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
                const ok = await act('cancel', () => postJson(`/api/chip-orders/${o.id}/cancel`, { reason: cancelReason.trim() }), 'הזמנת הקבלה בוטלה — הצ׳יפים שלה הושבתו');
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
