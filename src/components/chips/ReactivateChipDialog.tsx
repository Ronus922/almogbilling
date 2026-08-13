'use client';

// Reactivate-chip confirmation — a Dialog per DESIGN.md §12 (confirmation, not
// a CRUD form). Requires a free-text reason; warns that the chip must be
// re-added to the access controller (the server resets controller_synced to
// false). A 409 (number reused by another active chip / already active)
// renders inline as a red error box with the server's Hebrew message.

import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { AlertTriangle } from 'lucide-react';
import {
  Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { FIELD_LABEL } from '@/components/suppliers/SupplierField';
import { useEscapeKey } from '@/lib/hooks/useEscapeKey';
import { cn } from '@/lib/utils';
import type { Chip } from '@/lib/types/chips';

interface ReactivateChipDialogProps {
  chip: Chip | null;
  open: boolean;
  onOpenChange: (o: boolean) => void;
  onDone: () => void;
}

export function ReactivateChipDialog({
  chip, open, onOpenChange, onDone,
}: ReactivateChipDialogProps) {
  const [reason, setReason] = useState('');
  const [serverError, setServerError] = useState<string | null>(null);
  const [submitted, setSubmitted] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  // Fresh state on every open.
  useEffect(() => {
    if (!open) return;
    setReason('');
    setServerError(null);
    setSubmitted(false);
    setSubmitting(false);
  }, [open]);

  useEscapeKey(open, () => {
    if (!submitting) onOpenChange(false);
  });

  async function submit() {
    if (!chip || submitting) return;
    if (!reason.trim()) {
      setSubmitted(true);
      return;
    }
    setSubmitting(true);
    setServerError(null);
    try {
      const res = await fetch(`/api/chips/${chip.id}/reactivate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ reason: reason.trim() }),
      });
      const data = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) {
        const msg = data.error ?? 'ההפעלה מחדש נכשלה';
        if (res.status === 409) setServerError(msg);
        else toast.error(msg);
        return;
      }
      toast.success('הצ׳יפ הופעל מחדש');
      onOpenChange(false);
      onDone();
    } catch {
      toast.error('ההפעלה מחדש נכשלה');
    } finally {
      setSubmitting(false);
    }
  }

  if (!chip) return null;

  const reasonMissing = submitted && !reason.trim();

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!submitting) onOpenChange(o); }}>
      <DialogContent dir="rtl" showCloseButton={false} className="p-6 sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="text-lg font-bold text-slate-900">
            החזרה לפעילות — צ׳יפ{' '}
            <span dir="ltr" className="font-num tabular-nums">{chip.chip_number}</span>
          </DialogTitle>
        </DialogHeader>

        <div className="space-y-4">
          {/* Controller warning */}
          <div className="flex items-start gap-2 rounded-md border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-600" />
            <span>
              שים לב: יש להוסיף את הצ׳יפ מחדש בבקר הכניסה — הוא יסומן כלא מסונכרן.
            </span>
          </div>

          {/* Reason (required) */}
          <div className="space-y-1.5">
            <Label htmlFor="react-reason" className={FIELD_LABEL}>
              סיבה
              <span className="text-red-500"> *</span>
            </Label>
            <Input
              id="react-reason"
              value={reason}
              onChange={(e) => { setReason(e.target.value); setServerError(null); }}
              disabled={submitting}
              placeholder="לדוגמה: נמצא בלובי"
              className={cn(
                'h-10 px-3',
                reasonMissing &&
                  'border-red-400 bg-red-50 focus-visible:border-red-400 focus-visible:ring-red-200',
              )}
            />
            {reasonMissing && (
              <p className="text-start text-[12px] font-semibold text-red-500">
                ⚠️ נדרשת סיבת הפעלה מחדש
              </p>
            )}
          </div>

          {/* Server 409 — inline error */}
          {serverError && (
            <div className="rounded-[10px] border border-red-400 bg-red-50 p-4 text-sm font-semibold text-red-700">
              {serverError}
            </div>
          )}
        </div>

        <DialogFooter className="gap-2">
          <Button
            type="button"
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={submitting}
          >
            ביטול
          </Button>
          <Button
            type="button"
            onClick={() => void submit()}
            disabled={submitting}
          >
            {submitting ? 'מפעיל…' : 'החזר לפעילות'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
