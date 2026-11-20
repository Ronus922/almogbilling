'use client';

// "פירוט עסקה" of the issue window (20/11/2026 design, `.inv` of
// ref/chip-order/chip-issue-admin.html): the order's number and tags, who
// ordered, status, what was paid, the due date, "שויכו X מתוך Y", one line per
// apartment (its people, role, quantity, price), the price lines from the
// order's own snapshot, the total — and the order's buttons: "מוכן לאיסוף",
// "נאסף" (once ready), "דחה", and "מחק הזמנת בדיקה" (test orders only; it
// disables the order's chips first). The status belongs to the whole order.

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
import { CheckIco, Ico, TrashIco } from './parts';

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

function roleOf(roles: string[]): { label: string; renter: boolean } {
  const set = new Set(roles);
  if (set.size === 1 && set.has('tenant')) return { label: 'שוכר', renter: true };
  if (set.size === 1 && set.has('owner')) return { label: 'בעלים', renter: false };
  if (set.size === 1 && set.has('operator')) return { label: 'מפעיל', renter: true };
  if (set.has('owner') && set.has('tenant')) return { label: 'בעלים + שוכר', renter: false };
  return { label: 'אחר', renter: false };
}

export function OrderTransaction({
  win, pending, canEditOrders, disabled, onChanged, onGone, onModalChange,
}: {
  win: ChipOrderWindow;
  /** New numbers waiting in the window (not saved yet). */
  pending: number;
  /** chips_orders_manage:edit — the order's buttons. */
  canEditOrders: boolean;
  disabled: boolean;
  /** The order changed and stays open (ready) — reload. */
  onChanged: () => void;
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

  // Price lines from the order's own snapshot (per apartment).
  let base = 0, above = 0, baseTotal = 0, aboveTotal = 0;
  for (const i of win.items) {
    const b = Math.min(i.chips_count, i.threshold);
    const a = Math.max(0, i.chips_count - i.threshold);
    base += b; above += a;
    baseTotal += b * i.unit_price; aboveTotal += a * i.price_above;
  }
  const first = win.items[0];

  function setModal(kind: 'reject' | 'delete', open: boolean) {
    if (kind === 'reject') setRejectOpen(open);
    else setDeleteOpen(open);
    onModalChange(open);
  }

  async function act(key: string, run: () => Promise<{ refund_label?: string; refund_note?: string | null }>, okMsg: string, gone: boolean): Promise<boolean> {
    setBusy(key);
    try {
      const data = await run();
      toast.success(okMsg, data.refund_label ? { description: `זיכוי: ${data.refund_label}${data.refund_note ? ` — ${data.refund_note}` : ''}` } : undefined);
      if (gone) onGone();
      else onChanged();
      return true;
    } catch (e) {
      toast.error((e as Error).message);
      return false;
    } finally {
      setBusy(null);
    }
  }

  const stageTag = stage === 'ready' ? 'ci-solid' : stage === 'assigned' ? 'ci-green' : 'ci-amber';

  return (
    <div className="ci-inv" data-testid="chip-order-section">
      <div className="ci-invhead">
        <Ico size={15}><path d="M4 2v20l2-1 2 1 2-1 2 1 2-1 2 1 2-1 2 1V2l-2 1-2-1-2 1-2-1-2 1-2-1-2 1Z" /><path d="M16 8h-6a2 2 0 0 0 0 4h4a2 2 0 0 1 0 4H8" /></Ico>
        פירוט עסקה · הזמנה <span className="ci-num">{o.order_number}</span>
        {o.is_test && <span className="ci-tag ci-amber">{CHIP_ORDER_TEST_LABEL}</span>}
        {!o.phone_verified && <span className="ci-tag ci-red">{CHIP_ORDER_PHONE_UNVERIFIED_LABEL}</span>}
      </div>
      <div className="ci-invwho">
        <div><span>שם המזמין</span><b>{o.full_name}</b></div>
        <div><span>טלפון נייד</span><b className="ci-num">{phoneView(o.phone_e164)}</b></div>
        <div><span>מייל</span><b className="ci-num" title={o.email}>{o.email}</b></div>
        <div><span>כתובת מגורים</span><b className="ci-wrap">{o.address}</b></div>
        <div>
          <span>סטטוס</span>
          <b className="ci-wrap">
            <span className={cn('ci-tag', stageTag)}>{chipOrderStageLabel(stage, linkedAll, ordered)}</span>
            {overdue && <> <span className="ci-tag ci-red">באיחור</span></>}
          </b>
        </div>
        <div><span>סכום ששולם</span><b className="ci-num">{o.is_test ? 'בדיקה, ללא חיוב' : formatIlsAfter(o.total)}</b></div>
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
          return (
            <div key={i.id} className="ci-invapt">
              <span className="ci-aptno ci-num">{i.apartment_number}</span>
              <div className="ci-who">
                <b>{people.map((h) => h.full_name).join(', ') || o.full_name}</b>
                <small><span className="ci-num">{[...phones, ...emails].join(' · ')}</span></small>
              </div>
              <span className={cn('ci-role', r.renter && 'ci-renter')}>{r.label}</span>
              <span className="ci-aqty"><b className="ci-num">{i.chips_count}</b> כרטיסים</span>
              <span className="ci-aprice ci-num">{formatIlsAfter(i.line_total)}</span>
            </div>
          );
        })}
      </div>
      {first && (base > 0 || above > 0) && (
        <div className="ci-invlines">
          {base > 0 && (
            <div>
              <span>{first.threshold} הכרטיסים הראשונים לכל דירה — <b className="ci-num">{base}×{formatIlsAfter(first.unit_price)}</b></span>
              <b className="ci-num">{formatIlsAfter(baseTotal)}</b>
            </div>
          )}
          {above > 0 && (
            <div>
              <span>מהכרטיס ה-{first.threshold + 1} ואילך — <b className="ci-num">{above}×{formatIlsAfter(first.price_above)}</b></span>
              <b className="ci-num">{formatIlsAfter(aboveTotal)}</b>
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
          <div className="ci-oact">
            {assigning && (
              <button type="button" className="ci-btn ci-primary" disabled={disabled || busy !== null || !win.order_all_linked || pending > 0}
                title={!win.order_all_linked ? 'יש לשייך ולשמור קודם את כל הצ׳יפים שהוזמנו' : pending > 0 ? 'יש לשמור קודם את הצ׳יפים שנוספו' : undefined}
                onClick={() => void act('ready', () => postJson(`/api/chip-orders/${o.id}/ready`), 'סומן מוכן לאיסוף — נשלחה הודעה למזמין', false)}>
                {busy === 'ready' ? <Loader2 className="ci-spin h-3.5 w-3.5" /> : <CheckIco />}
                מוכן לאיסוף
              </button>
            )}
            {o.status === 'ready' && (
              <button type="button" className="ci-btn ci-green" disabled={disabled || busy !== null}
                onClick={() => void act('collected', () => postJson(`/api/chip-orders/${o.id}/collected`), 'סומן כנאסף', true)}>
                {busy === 'collected' ? <Loader2 className="ci-spin h-3.5 w-3.5" /> : <CheckIco />}
                נאסף
              </button>
            )}
            {assigning && (
              <button type="button" className="ci-btn ci-line" disabled={disabled || busy !== null} onClick={() => setModal('reject', true)}>
                דחה
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
                const ok = await act('reject', () => postJson(`/api/chip-orders/${o.id}/reject`, { reason: rejectReason.trim() }), 'ההזמנה נדחתה', true);
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
                const ok = await act('delete', () => postJson(`/api/chip-orders/${o.id}`, undefined, 'DELETE'), 'הזמנת הבדיקה נמחקה', true);
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
