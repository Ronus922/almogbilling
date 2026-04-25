'use client';

import { useEffect, useMemo, useState } from 'react';
import {
  Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { cn } from '@/lib/utils';
import { validatePhone } from '@/lib/validation';

export type PhoneField = 'phone_owner' | 'phone_tenant';

interface Props {
  open: boolean;
  field: PhoneField;
  initialValue: string | null;
  onOpenChange: (open: boolean) => void;
  onSave: (field: PhoneField, value: string | null) => Promise<void>;
}

const LABELS: Record<PhoneField, string> = {
  phone_owner: 'טלפון בעלים',
  phone_tenant: 'טלפון שוכר',
};

export function EditPhoneDialog({ open, field, initialValue, onOpenChange, onSave }: Props) {
  const [value, setValue] = useState<string>(initialValue ?? '');
  const [saving, setSaving] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);

  useEffect(() => {
    if (open) {
      setValue(initialValue ?? '');
      setSubmitError(null);
      setSaving(false);
    }
  }, [open, initialValue]);

  const trimmed = value.trim();
  const willClear = trimmed === '';

  // Inline validation result. willClear is allowed (means "delete the phone").
  const validation = useMemo(() => validatePhone(trimmed), [trimmed]);
  const liveError = !willClear && !validation.valid && trimmed.length > 0
    ? validation.error ?? 'מספר לא תקין'
    : null;
  const canSave = willClear || validation.valid;
  const errorToShow = submitError ?? liveError;

  async function handleSave() {
    if (!canSave) return;
    setSaving(true);
    setSubmitError(null);
    try {
      await onSave(field, willClear ? null : validation.normalized);
      onOpenChange(false);
    } catch (err) {
      setSubmitError((err as Error).message || 'שמירה נכשלה');
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent dir="rtl" className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>עריכת {LABELS[field]}</DialogTitle>
        </DialogHeader>
        <div className="space-y-3">
          <Label htmlFor="phone-input" className="text-right text-sm font-medium">
            מספר טלפון
          </Label>
          <Input
            id="phone-input"
            type="tel"
            inputMode="tel"
            autoComplete="tel"
            dir="ltr"
            className={cn(
              'h-10 text-left tabular-nums',
              errorToShow && 'border-red-400 bg-red-50 focus-visible:ring-red-200',
            )}
            value={value}
            onChange={(e) => { setValue(e.target.value); setSubmitError(null); }}
            onKeyDown={(e) => { if (e.key === 'Enter' && !saving && canSave) handleSave(); }}
            placeholder="052-1234567"
            autoFocus
          />
          {errorToShow ? (
            <p className="text-[12px] font-semibold text-red-500 text-right">
              ⚠️ {errorToShow}
            </p>
          ) : (
            <p className="text-xs text-muted-foreground text-right">
              להשאיר ריק כדי למחוק את המספר. נייד 10 ספרות / קווי 9 ספרות / +972…
            </p>
          )}
        </div>
        <DialogFooter className="gap-2">
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={saving}>ביטול</Button>
          <Button onClick={handleSave} disabled={saving || !canSave}>
            {saving ? 'שומר…' : 'שמור'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
