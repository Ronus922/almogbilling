'use client';

// "ביטול וזיכוי" of a reception order (27/11/2026) — ONE confirmation, opened
// from the three places a paid reception order is seen (admin and super admin
// only; the route asks the role again):
//   · the order's line in the issue window of the apartment (ReceptionRecords);
//   · its row in the Orders tab (ChipOrdersPanel);
//   · the order's own window (OrderTransaction).
// The confirmation loads what the server knows (GET /api/chip-orders/[id]/
// cancel) and states, in the order the steps run: how the money goes back
// (the card through PayPlus — or nothing more when PayPlus already shows it
// cancelled / refunded; cash and a transfer by hand), the credit document in
// Morning and the email it goes to, the order marked "בוטלה", and — said out
// loud — every chip issued to the order that will be disabled (never deleted).
// A step that failed is shown at the top with its words; "נסה שוב" runs the
// remaining steps only (a refund that went through is never sent again).
// DESIGN.md §12: AlertDialog for a confirmation; destructive red button.

import { useCallback, useEffect, useState } from 'react';
import { toast } from 'sonner';
import { Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import {
  AlertDialog, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter,
  AlertDialogHeader, AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { cn } from '@/lib/utils';
import { formatIlsAfter } from '@/lib/chipOrders/model';
import {
  RECEPTION_CANCEL_LABEL, RECEPTION_CANCEL_STEP_LABEL, receptionCancelMoneyText, type ReceptionCancelPreviewView,
} from '@/lib/chipOrders/receptionCancelText';

interface RunAnswer {
  ok?: boolean;
  error?: string;
  failed_step?: 'refund' | 'credit' | 'cancel' | null;
  message?: string | null;
  refund?: 'refunded' | 'outside' | 'by_hand' | 'none';
  credit_numbers?: string[];
  credit_email?: { status: 'sent'; to: string } | { status: 'no_email' } | null;
  chips_disabled?: number;
}

type PreviewResult = { ok: true; preview: ReceptionCancelPreviewView } | { ok: false; error: string };

async function fetchPreview(orderId: string): Promise<PreviewResult> {
  try {
    const res = await fetch(`/api/chip-orders/${orderId}/cancel`, { credentials: 'include', cache: 'no-store' });
    const data = (await res.json().catch(() => ({}))) as ReceptionCancelPreviewView & { error?: string };
    if (!res.ok) return { ok: false, error: data.error === 'not_found' ? 'ההזמנה לא נמצאה' : data.error ?? 'טעינת ההזמנה נכשלה' };
    return { ok: true, preview: data };
  } catch {
    return { ok: false, error: 'טעינת ההזמנה נכשלה' };
  }
}

interface DialogProps {
  orderId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The order changed — `done` (cancelled and refunded) or `stopped` (a
   *  step failed; the order says which): reload what shows it. */
  onChanged: (result: 'done' | 'stopped') => void;
}

/** Mounted only while open: every opening starts from what the server says now. */
export function ReceptionCancelDialog(props: DialogProps) {
  return props.open ? <CancelDialogBody {...props} /> : null;
}

function CancelDialogBody({ orderId, open, onOpenChange, onChanged }: DialogProps) {
  const [preview, setPreview] = useState<ReceptionCancelPreviewView | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);

  const show = useCallback((r: PreviewResult) => {
    if (r.ok) {
      setPreview(r.preview);
      setLoadError(null);
    } else {
      setLoadError(r.error);
    }
  }, []);
  const load = useCallback(async () => show(await fetchPreview(orderId)), [orderId, show]);

  useEffect(() => {
    let alive = true;
    void fetchPreview(orderId).then((r) => { if (alive) show(r); });
    return () => { alive = false; };
  }, [orderId, show]);

  const p = preview;
  const resuming = p?.requested_at != null;
  const canRun = p !== null && p.cancellable && !busy && (resuming || reason.trim().length >= 2);

  async function run() {
    if (!p) return;
    setBusy(true);
    try {
      const res = await fetch(`/api/chip-orders/${orderId}/cancel`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(resuming ? {} : { reason: reason.trim() }),
      });
      const data = (await res.json().catch(() => ({}))) as RunAnswer;
      if (!res.ok) {
        toast.error(data.error ?? 'הפעולה נכשלה');
        await load();
        return;
      }
      onChanged(data.ok ? 'done' : 'stopped');
      if (data.ok) {
        const parts: string[] = [];
        if (data.refund === 'refunded') parts.push(`${formatIlsAfter(p.amount)} זוכו לכרטיס דרך PayPlus`);
        else if (data.refund === 'outside') parts.push('הזיכוי כבר בוצע בממשק PayPlus — לא נשלח זיכוי נוסף');
        else if (data.refund === 'by_hand') parts.push('את הכסף מחזירים ידנית');
        if (data.credit_numbers && data.credit_numbers.length > 0) {
          parts.push(`מסמך זיכוי ${data.credit_numbers.join(', ')}`
            + (data.credit_email?.status === 'sent' ? ` נשלח למייל ${data.credit_email.to}` : data.credit_email?.status === 'no_email' ? ' (בלי מייל — אין מייל בהזמנה)' : ''));
        }
        if (data.chips_disabled) parts.push(data.chips_disabled === 1 ? 'צ׳יפ אחד הושבת' : `${data.chips_disabled} צ׳יפים הושבתו`);
        toast.success(`הזמנה ${p.order_number} בוטלה וזוכתה`, { description: parts.join(' · ') });
        onOpenChange(false);
      } else {
        toast.error(`הביטול נעצר בשלב: ${data.failed_step ? RECEPTION_CANCEL_STEP_LABEL[data.failed_step] : '—'}`, { description: data.message ?? undefined });
        await load();
      }
    } catch {
      toast.error('אין תשובה מהשרת — בדקו את מצב ההזמנה לפני ניסיון נוסף');
      await load();
    } finally {
      setBusy(false);
    }
  }

  const money = p ? receptionCancelMoneyText(p) : '';
  const refundDone = p?.refunded === true;
  const creditDone = (p?.credit_numbers.length ?? 0) > 0;

  return (
    <AlertDialog open={open} onOpenChange={(v) => { if (!busy) onOpenChange(v); }}>
      <AlertDialogContent dir="rtl" className="p-6" data-testid="reception-cancel-dialog">
        <AlertDialogHeader>
          <AlertDialogTitle>
            {p ? `${RECEPTION_CANCEL_LABEL} — הזמנת קבלה ${p.order_number}` : RECEPTION_CANCEL_LABEL}
          </AlertDialogTitle>
          <AlertDialogDescription>
            {p ? (
              <>סכום: <b className="tabular-nums" data-testid="reception-cancel-amount">{formatIlsAfter(p.amount)}</b>. הפעולה מבצעת, לפי הסדר:</>
            ) : loadError ?? 'טוען…'}
          </AlertDialogDescription>
        </AlertDialogHeader>

        {p && p.failed_step && (
          <div role="alert" className="rounded-lg border border-red-200 bg-red-50 p-3 text-[13px] leading-relaxed text-red-900" data-testid="reception-cancel-failed">
            <b>הביטול נעצר בשלב: {RECEPTION_CANCEL_STEP_LABEL[p.failed_step]}</b>
            {p.error && <p className="mt-1">{p.error}</p>}
            <p className="mt-1">„נסה שוב” ממשיך מהשלב הזה. שלב שהושלם לא חוזר — לא יישלח זיכוי שני.</p>
          </div>
        )}

        {p && (
          <ol className="flex list-decimal flex-col gap-2 ps-5 text-[13.5px] leading-relaxed text-slate-800" data-testid="reception-cancel-steps">
            <li data-testid="reception-cancel-step-refund" className={cn(refundDone && 'text-emerald-800')}>
              {refundDone
                ? <>הכסף הוחזר{p.refund_via === 'payplus' ? ' — בממשק PayPlus' : ' דרך PayPlus'}. ✓</>
                : money}
            </li>
            <li data-testid="reception-cancel-step-credit" className={cn(creditDone && 'text-emerald-800')}>
              {p.is_test
                ? 'הזמנת בדיקה — לא מופק מסמך במורנינג.'
                : !p.has_invoice
                  ? 'להזמנה אין חשבונית במורנינג (נרשמה לפני 26/11/2026) — לא מופק מסמך זיכוי.'
                  : creditDone
                    ? <>מסמך הזיכוי הופק במורנינג: <span className="tabular-nums">{p.credit_numbers.join(', ')}</span>. ✓</>
                    : (
                      <>
                        {p.invoice_number
                          ? <>מסמך זיכוי במורנינג לחשבונית <span className="tabular-nums">{p.invoice_number}</span></>
                          : 'מסמך זיכוי במורנינג לחשבונית של ההזמנה (שתופק לפניו)'}
                        {p.email
                          ? <> — מורנינג ישלח אותו למייל <span dir="ltr" className="tabular-nums" data-testid="reception-cancel-email">{p.email}</span>.</>
                          : ' — בהזמנה אין מייל, ולכן המסמך לא יישלח במייל.'}
                      </>
                    )}
            </li>
            <li>ההזמנה תסומן „בוטלה” ותישאר בטבלת ההזמנות.</li>
            <li data-testid="reception-cancel-step-chips">
              {p.chips.length === 0 ? 'לא הונפקו להזמנה צ׳יפים פעילים.' : (
                <span className="block rounded-lg border border-amber-200 bg-amber-50 p-3 text-amber-900" data-testid="reception-cancel-chips">
                  <b>
                    {p.chips.length === 1
                      ? 'להזמנה הונפק צ׳יפ פעיל אחד — הוא יושבת'
                      : `להזמנה הונפקו ${p.chips.length} צ׳יפים פעילים — כולם יושבתו`}
                  </b>
                  {' '}(לא נמחקים; אפשר להחזיר כל אחד לפעיל):{' '}
                  <span dir="ltr" className="tabular-nums">{p.chips.join(', ')}</span>
                </span>
              )}
            </li>
          </ol>
        )}

        {p && (
          <p className="text-[12.5px] text-slate-600">לא נשלחת הודעה ללקוח, מלבד מסמך הזיכוי של מורנינג. אי אפשר לבטל את הביטול.</p>
        )}

        {p && !resuming && (
          <Textarea
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder="סיבת הביטול (חובה)"
            maxLength={500}
            className="min-h-[96px] px-3 py-2"
            aria-label="סיבת הביטול"
          />
        )}
        {p && resuming && p.reason && (
          <p className="text-[13px] text-slate-700">
            סיבת הביטול: {p.reason}{p.requested_by_name ? ` · ${p.requested_by_name}` : ''}
          </p>
        )}

        <AlertDialogFooter>
          <AlertDialogCancel disabled={busy} className="h-11 px-4">חזרה</AlertDialogCancel>
          <Button
            type="button"
            disabled={!canRun}
            onClick={() => void run()}
            className="h-11 gap-2 bg-destructive px-4 text-white hover:bg-destructive/90"
            data-testid="reception-cancel-run"
          >
            {busy && <Loader2 className="h-4 w-4 animate-spin" />}
            {resuming ? 'נסה שוב' : p ? `${RECEPTION_CANCEL_LABEL} ${formatIlsAfter(p.amount)}` : RECEPTION_CANCEL_LABEL}
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
