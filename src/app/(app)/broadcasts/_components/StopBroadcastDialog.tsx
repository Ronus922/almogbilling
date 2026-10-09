'use client';

import { Loader2, OctagonX } from 'lucide-react';
import {
  AlertDialog, AlertDialogContent, AlertDialogHeader, AlertDialogTitle,
  AlertDialogDescription, AlertDialogFooter,
} from '@/components/ui/alert-dialog';
import { Button } from '@/components/ui/button';

// Confirmation before a REAL, server-side, irreversible stop. Shows the live
// counts so the operator knows exactly what will (and won't) happen: already-sent
// messages cannot be recalled; everything not yet sent is cancelled. While the
// cancel request is in flight the primary button is disabled and reads
// "עוצר את התפוצה…" — the caller keeps polling until the status reaches 'cancelled'.
export interface StopCounts {
  sent: number;
  failed: number;
  remaining: number;
  total: number;
}

export function StopBroadcastDialog({
  open, onOpenChange, counts, pending, onConfirm,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  counts: StopCounts | null;
  pending: boolean;
  onConfirm: () => void;
}) {
  return (
    <AlertDialog open={open} onOpenChange={(o) => { if (!pending) onOpenChange(o); }}>
      <AlertDialogContent dir="rtl">
        <AlertDialogHeader>
          <AlertDialogTitle>לעצור את התפוצה?</AlertDialogTitle>
          <AlertDialogDescription>
            הודעות שכבר נשלחו לא ניתנות לביטול. לאחר האישור המערכת תפסיק לשלוח
            הודעות נוספות ותבטל את יתרת הנמענים שטרם נשלחו.
          </AlertDialogDescription>
        </AlertDialogHeader>

        {counts && (
          <dl className="grid grid-cols-2 gap-2 rounded-lg border border-slate-200 bg-slate-50 p-3 text-sm sm:grid-cols-4">
            <Stat label="נשלחו" value={counts.sent} tone="text-emerald-700" />
            <Stat label="נכשלו" value={counts.failed} tone="text-red-600" />
            <Stat label="ייוותרו ויבוטלו" value={counts.remaining} tone="text-amber-700" />
            <Stat label="סך הכול" value={counts.total} tone="text-slate-700" />
          </dl>
        )}

        <AlertDialogFooter>
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)} disabled={pending}>
            חזרה
          </Button>
          <Button
            type="button"
            onClick={onConfirm}
            disabled={pending}
            className="gap-2 bg-destructive text-white hover:bg-destructive/90"
          >
            {pending ? <Loader2 className="h-4 w-4 animate-spin" /> : <OctagonX className="h-4 w-4" />}
            {pending ? 'עוצר את התפוצה…' : 'עצירת התפוצה'}
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

function Stat({ label, value, tone }: { label: string; value: number; tone: string }) {
  return (
    <div className="flex flex-col">
      <dt className="text-xs text-slate-500">{label}</dt>
      <dd className={`text-lg font-bold tabular-nums ${tone}`}>{value}</dd>
    </div>
  );
}
