'use client';

// "סגירה ידנית" (27/11/2026) — the confirmation of closing a stuck "ביטול
// וזיכוי" by hand, super admin only (the route asks the role again). It says
// what is NOT done (nothing goes to PayPlus or Morning for the step it stopped
// at), what is (the order cancelled, its chips disabled, a permanent mark),
// and takes the reason — required. POST /api/chip-orders/[id]/close-by-hand.

import { useState } from 'react';
import { toast } from 'sonner';
import { Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import {
  AlertDialog, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter,
  AlertDialogHeader, AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import type { CloseByHandStep } from '@/lib/chipOrders/model';
import {
  CLOSED_BY_HAND_ACTION, CLOSED_BY_HAND_LABEL, CLOSED_BY_HAND_SKIPPED, RECEPTION_CANCEL_STEP_LABEL,
} from '@/lib/chipOrders/receptionCancelText';

export function CloseByHandDialog({
  orderId, orderNumber, step, activeChips, open, onOpenChange, onClosed,
}: {
  orderId: string;
  orderNumber: number;
  step: CloseByHandStep;
  /** The order's active chips — all of them are disabled. */
  activeChips: number;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onClosed: () => void;
}) {
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const canRun = !busy && reason.trim().length >= 2;

  async function run() {
    setBusy(true);
    try {
      const res = await fetch(`/api/chip-orders/${orderId}/close-by-hand`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ reason: reason.trim() }),
      });
      const data = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string; chips_disabled?: number };
      if (!res.ok || !data.ok) {
        toast.error(data.error ?? 'הסגירה הידנית נכשלה');
        return;
      }
      toast.success(`הזמנה ${orderNumber} ${CLOSED_BY_HAND_LABEL}`, {
        description: data.chips_disabled ? (data.chips_disabled === 1 ? 'צ׳יפ אחד הושבת' : `${data.chips_disabled} צ׳יפים הושבתו`) : undefined,
      });
      onOpenChange(false);
      onClosed();
    } catch {
      toast.error('אין תשובה מהשרת — בדקו את מצב ההזמנה לפני ניסיון נוסף');
    } finally {
      setBusy(false);
    }
  }

  return (
    <AlertDialog open={open} onOpenChange={(v) => { if (!busy) onOpenChange(v); }}>
      <AlertDialogContent dir="rtl" className="p-6" data-testid="close-by-hand-dialog">
        <AlertDialogHeader>
          <AlertDialogTitle>{CLOSED_BY_HAND_ACTION} — הזמנה {orderNumber}</AlertDialogTitle>
          <AlertDialogDescription>
            „ביטול וזיכוי” נעצר בשלב: {RECEPTION_CANCEL_STEP_LABEL[step]}. סגירה ידנית מסיימת את ההזמנה בלי לשלוח דבר ל-PayPlus או למורנינג:
          </AlertDialogDescription>
        </AlertDialogHeader>
        <ul className="flex list-disc flex-col gap-1.5 ps-5 text-[13px] leading-relaxed text-slate-700">
          <li data-testid="close-by-hand-skipped">{CLOSED_BY_HAND_SKIPPED[step]}</li>
          <li>
            ההזמנה תבוטל
            {activeChips > 0 ? (activeChips === 1 ? ', והצ׳יפ הפעיל שלה יושבת' : `, ו-${activeChips} הצ׳יפים הפעילים שלה יושבתו`) : ''}.
          </li>
          <li>ההזמנה תסומן לצמיתות „{CLOSED_BY_HAND_LABEL}”, עם שמך, הסיבה והשלב. לא נשלחת הודעה למזמין.</li>
        </ul>
        <Textarea
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          placeholder="הסיבה לסגירה הידנית (חובה)"
          maxLength={500}
          className="min-h-[96px] px-3 py-2"
          aria-label="הסיבה לסגירה הידנית"
        />
        <AlertDialogFooter>
          <AlertDialogCancel disabled={busy} className="h-11 px-4">חזרה</AlertDialogCancel>
          <Button
            type="button"
            disabled={!canRun}
            onClick={() => void run()}
            className="h-11 gap-2 bg-destructive px-4 text-white hover:bg-destructive/90"
            data-testid="close-by-hand-run"
          >
            {busy && <Loader2 className="h-4 w-4 animate-spin" />}
            {CLOSED_BY_HAND_ACTION}
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
