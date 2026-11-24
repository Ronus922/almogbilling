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
  CHIP_ORDER_PHONE_UNVERIFIED_LABEL, CHIP_ORDER_TEST_LABEL, chipOrderStage, chipOrderStageLabel, formatIlsAfter,
  isChipOrderOverdue, type ChipOrderWindow,
} from '@/lib/chipOrders/model';
import { e164ToLocal } from '@/lib/portal/phone';
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
  win, readyAction, canEditOrders, disabled, onGone, onModalChange,
}: {
  win: ChipOrderWindow;
  /** "מוכן לאיסוף" of an order that is being assigned: whether it may be
   *  pressed now, why not (`reason`, shown under the buttons), and the click —
   *  which saves the window first. */
  readyAction: { can: boolean; busy: boolean; reason: string | null; run: () => void };
  /** chips_orders_manage:edit — the order's buttons. */
  canEditOrders: boolean;
  disabled: boolean;
  /** The order left the open list (collected / rejected / deleted). */
  onGone: () => void;
  onModalChange: (open: boolean) => void;
}) {
  const [busy, setBusy] = useState<string | null>(null);
  const [rejectOpen, setRejectOpen] = useState(false);
  const [rejectReason, setRejectReason] = useState('');
  const [deleteOpen, setDeleteOpen] = useState(false);

  const o = win.order;
  const ordered = win.items.reduce((s, i) => s + i.chips_count, 0);
  const linked = win.items.reduce((s, i) => s + Math.min(i.chips_linked, i.chips_count), 0);
  const linkedAll = win.items.reduce((s, i) => s + i.chips_linked, 0);
  const stage = chipOrderStage(o.status, linkedAll, ordered);
  const overdue = isChipOrderOverdue(o);
  const assigning = o.status === 'paid' || o.status === 'approved';
  const ready = o.status === 'ready';
  // Closed orders leave the Orders tab, but that list does not refresh on its
  // own: a row another user (or tab) already closed still opens this window.
  const collected = o.status === 'collected';
  const rejected = o.status === 'rejected';

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

  function setModal(kind: 'reject' | 'delete', open: boolean) {
    if (kind === 'reject') setRejectOpen(open);
    else setDeleteOpen(open);
    onModalChange(open);
  }

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

  const stageTag = stage === 'ready' ? 'ci-solid' : stage === 'assigned' ? 'ci-green' : 'ci-amber';
  // Why "מוכן לאיסוף" cannot be pressed — a visible line, not only a tooltip.
  // Amber while something is still missing; quiet once the order moved on.
  const readyNote: { text: string; quiet: boolean } | null = assigning
    ? (readyAction.reason ? { text: readyAction.reason, quiet: false } : null)
    : ready ? { text: 'ההזמנה כבר מוכנה לאיסוף — השלב הבא: „נאסף”', quiet: true }
      : collected ? { text: 'ההזמנה כבר נאספה', quiet: true }
        : rejected ? { text: 'ההזמנה נדחתה', quiet: true }
          : null;

  return (
    <div className="ci-inv" data-testid="chip-order-section">
      <div className="ci-invhead">
        <Ico size={15}><path d="M4 2v20l2-1 2 1 2-1 2 1 2-1 2 1 2-1 2 1V2l-2 1-2-1-2 1-2-1-2 1-2-1-2 1Z" /><path d="M16 8h-6a2 2 0 0 0 0 4h4a2 2 0 0 1 0 4H8" /></Ico>
        פירוט עסקה · הזמנה <span className="ci-num">{o.order_number}</span>
        {o.is_test && <span className="ci-tag ci-amber"><FlaskIco />{CHIP_ORDER_TEST_LABEL}</span>}
        {!o.phone_verified && <span className="ci-tag ci-red">{CHIP_ORDER_PHONE_UNVERIFIED_LABEL}</span>}
      </div>
      <div className="ci-invwho">
        <div><span>שם המזמין</span><b>{o.full_name}</b></div>
        <div><span>טלפון נייד</span><b className="ci-num">{phoneView(o.phone_e164)}</b></div>
        <div><span>מייל</span><b className="ci-num">{o.email}</b></div>
        <div><span>כתובת מגורים</span><b>{o.address}</b></div>
        <div>
          <span>סטטוס</span>
          <b>
            <span className={cn('ci-tag', stageTag)}>{chipOrderStageLabel(stage, linkedAll, ordered)}</span>
            {overdue && <> <span className="ci-tag ci-red">באיחור</span></>}
          </b>
        </div>
        <div><span>סכום ששולם</span>{o.is_test ? <b>בדיקה, ללא חיוב</b> : <b className="ci-num">{formatIlsAfter(o.total)}</b>}</div>
        <div>
          <span>יעד להכנה</span>
          <b className={cn('ci-num', overdue && 'ci-late')}>{o.due_at ? DUE.format(new Date(o.due_at)) : '—'}</b>
        </div>
        <div>
          <span>שויכו</span>
          <b data-testid="chip-order-progress"><span className="ci-num">{linked}</span> מתוך <span className="ci-num">{ordered}</span></b>
        </div>
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
              onClick={() => void act('collected', () => postJson(`/api/chip-orders/${o.id}/collected`), 'סומן כנאסף')}>
              {busy === 'collected' ? <Loader2 className="ci-spin h-3.5 w-3.5" /> : <CheckAllIco />}
              נאסף
            </button>
            <button type="button" className={cn('ci-btn ci-line', rejected && 'ci-cur')}
              disabled={disabled || busy !== null || !assigning}
              aria-current={rejected ? 'step' : undefined}
              title={assigning ? undefined : rejected ? 'ההזמנה נדחתה — זה השלב שלה כרגע' : collected ? 'ההזמנה כבר נאספה' : 'אפשר לדחות הזמנה רק לפני „מוכן לאיסוף”'}
              onClick={() => setModal('reject', true)}>
              דחה
            </button>
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
