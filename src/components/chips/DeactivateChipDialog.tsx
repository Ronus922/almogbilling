'use client';

// Deactivate-chip confirmation — a Dialog is correct here per DESIGN.md §12
// (confirmation prompt, not a CRUD form). Requires a reason (Select over
// DEACTIVATION_REASON_LABEL); optional note + "updated in access controller"
// checkbox. Two commit paths: plain deactivate, or deactivate + reissue a
// replacement (onDone({ reissue: true }) — the parent opens IssueChipSheet).

import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import {
  Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Checkbox } from '@/components/ui/checkbox';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select';
import { FIELD_LABEL } from '@/components/suppliers/SupplierField';
import { useEscapeKey } from '@/lib/hooks/useEscapeKey';
import { cn } from '@/lib/utils';
import { CHIP_DEACTIVATION_REASONS, DEACTIVATION_REASON_LABEL } from '@/lib/constants/chips';
import type { Chip, ChipDeactivationReason } from '@/lib/types/chips';

interface DeactivateChipDialogProps {
  chip: Chip | null;
  open: boolean;
  onOpenChange: (o: boolean) => void;
  onDone: (opts?: { reissue?: boolean }) => void;
}

export function DeactivateChipDialog({
  chip, open, onOpenChange, onDone,
}: DeactivateChipDialogProps) {
  const [reason, setReason] = useState<ChipDeactivationReason | null>(null);
  const [note, setNote] = useState('');
  const [controllerSynced, setControllerSynced] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [serverError, setServerError] = useState<string | null>(null);

  // Fresh state on every open.
  useEffect(() => {
    if (!open) return;
    setReason(null);
    setNote('');
    setControllerSynced(false);
    setSubmitted(false);
    setSubmitting(false);
    setServerError(null);
  }, [open]);

  useEscapeKey(open, () => {
    if (!submitting) onOpenChange(false);
  });

  async function submit(reissue: boolean) {
    if (!chip || submitting) return;
    if (!reason) {
      setSubmitted(true);
      return;
    }
    setSubmitting(true);
    setServerError(null);
    try {
      const res = await fetch(`/api/chips/${chip.id}/deactivate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({
          reason,
          note: note.trim() || undefined,
          controller_synced: controllerSynced,
        }),
      });
      const data = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) {
        const msg = data.error ?? 'ההשבתה נכשלה';
        // 409/422 (e.g. "הצ׳יפ כבר מושבת") render inline — not only toast.
        if (res.status === 409 || res.status === 422) setServerError(msg);
        else toast.error(msg);
        return;
      }
      toast.success('הצ׳יפ הושבת');
      onOpenChange(false);
      onDone(reissue ? { reissue: true } : undefined);
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setSubmitting(false);
    }
  }

  if (!chip) return null;

  const reasonMissing = submitted && !reason;

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!submitting) onOpenChange(o); }}>
      <DialogContent dir="rtl" showCloseButton={false} className="p-6 sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="text-lg font-bold text-slate-900">
            השבתת צ׳יפ{' '}
            <span dir="ltr" className="font-num tabular-nums">{chip.chip_number}</span>
          </DialogTitle>
        </DialogHeader>

        <div className="space-y-4">
          {/* Reason (required) */}
          <div className="space-y-1.5">
            <Label className={FIELD_LABEL}>
              סיבת השבתה
              <span className="text-red-500"> *</span>
            </Label>
            <Select
              value={reason}
              onValueChange={(v) => {
                if (typeof v === 'string' && v) {
                  setReason(v as ChipDeactivationReason);
                  setServerError(null);
                }
              }}
              disabled={submitting}
            >
              <SelectTrigger
                className={cn(
                  'w-full data-[size=default]:h-10',
                  reasonMissing && 'border-red-400 bg-red-50',
                )}
              >
                <SelectValue placeholder="בחר סיבה">
                  {(value: string | null) =>
                    value ? DEACTIVATION_REASON_LABEL[value as ChipDeactivationReason] : null}
                </SelectValue>
              </SelectTrigger>
              <SelectContent>
                {CHIP_DEACTIVATION_REASONS.map((r) => (
                  <SelectItem key={r} value={r}>{DEACTIVATION_REASON_LABEL[r]}</SelectItem>
                ))}
              </SelectContent>
            </Select>
            {reasonMissing && (
              <p className="text-right text-[12px] font-semibold text-red-500">
                ⚠️ נדרשת סיבת השבתה
              </p>
            )}
          </div>

          {/* Optional note */}
          <div className="space-y-1.5">
            <Label htmlFor="deact-note" className={FIELD_LABEL}>הערה</Label>
            <Textarea
              id="deact-note"
              value={note}
              onChange={(e) => setNote(e.target.value)}
              disabled={submitting}
              placeholder="פרטים נוספים (אופציונלי)…"
              className="min-h-[74px] px-3 py-2"
            />
          </div>

          {/* Controller sync */}
          <div className="flex items-center gap-2">
            <Checkbox
              id="deact-controller"
              checked={controllerSynced}
              onCheckedChange={(v) => setControllerSynced(v === true)}
              disabled={submitting}
            />
            <Label
              htmlFor="deact-controller"
              className="cursor-pointer text-sm font-medium text-slate-700"
            >
              עודכן בבקר הכניסה
            </Label>
          </div>

          {/* Server 409/422 — inline error */}
          {serverError && (
            <div className="rounded-[10px] border border-red-400 bg-red-50 p-4 text-sm font-semibold text-red-700">
              {serverError}
            </div>
          )}
        </div>

        <DialogFooter className="gap-2">
          <Button
            type="button"
            variant="ghost"
            onClick={() => onOpenChange(false)}
            disabled={submitting}
          >
            ביטול
          </Button>
          <Button
            type="button"
            variant="outline"
            onClick={() => void submit(true)}
            disabled={submitting}
          >
            השבת והנפק חלופי
          </Button>
          <Button
            type="button"
            variant="destructive"
            onClick={() => void submit(false)}
            disabled={submitting}
          >
            {submitting ? 'משבית…' : 'השבת צ׳יפ'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
