'use client';

import { useState } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from '@/components/ui/dialog';
import { Field } from '@/components/side-panel/Field';
import { useEscapeKey } from '@/lib/hooks/useEscapeKey';
import { amountToInput } from '@/lib/finance/format';
import type { RenovationFundSettings } from '@/lib/types/finance';

// Single-field edit of the fund's collection target — a Dialog, as DESIGN.md
// §12 reserves Dialog for single-field quick edits. Mount with a fresh `key`
// per open so the input starts from the current target.
export function FundTargetDialog({ open, onOpenChange, target, onSaved }: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  target: number;
  onSaved: (s: RenovationFundSettings) => void;
}) {
  const [value, setValue] = useState(target > 0 ? amountToInput(target) : '');
  const [touched, setTouched] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  const num = Number(value.replace(/,/g, '').trim());
  const error = value.trim() === ''
    ? null
    : !Number.isFinite(num) || num < 0 ? 'יש להזין סכום 0 או גדול ממנו' : null;
  const canSubmit = !error && !submitting;

  useEscapeKey(open, () => { if (!submitting) onOpenChange(false); });

  async function save() {
    setTouched(true);
    if (!canSubmit) return;
    setSubmitting(true);
    try {
      const target_amount = value.trim() === '' ? 0 : Math.round(num * 100) / 100;
      const r = await fetch('/api/finance/fund-settings', {
        method: 'PUT', headers: { 'Content-Type': 'application/json' }, credentials: 'include',
        body: JSON.stringify({ target_amount }),
      });
      const data = (await r.json().catch(() => ({}))) as { settings?: RenovationFundSettings; error?: string };
      if (!r.ok || !data.settings) throw new Error(data.error ?? 'שמירה נכשלה');
      toast.success('יעד הגבייה עודכן');
      onSaved(data.settings);
      onOpenChange(false);
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!submitting) onOpenChange(o); }}>
      <DialogContent dir="rtl" className="p-6">
        <DialogHeader className="text-start">
          <DialogTitle>יעד גבייה לקרן השיפוצים</DialogTitle>
          <DialogDescription>הסכום שהקרן אמורה לגבות. אחוז הגבייה ופס ההתקדמות נמדדים מולו. ריק = אין יעד.</DialogDescription>
        </DialogHeader>
        <form
          onSubmit={(e) => { e.preventDefault(); void save(); }}
          className="space-y-4"
        >
          <Field
            id="fund-target"
            label="יעד גבייה (₪)"
            value={value}
            onChange={setValue}
            onBlur={() => setTouched(true)}
            error={touched ? error : null}
            disabled={submitting}
            dir="ltr"
            inputMode="decimal"
            tabularNums
            placeholder="0"
            autoFocus
          />
          <DialogFooter className="gap-2 sm:justify-start">
            <Button type="submit" disabled={!canSubmit}>{submitting ? 'שומר…' : 'שמור'}</Button>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)} disabled={submitting}>ביטול</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
