'use client';

// "ערוך שם" on an identity already in force — a single-field quick edit
// (DESIGN.md §12: Dialog, not Sheet). names/apartments/status are untouched;
// only display_name changes, through the 'rename' action on the same
// /api/admin/portal-identity endpoint "אדם אחד" uses.

import { useEffect, useState } from 'react';
import {
  Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';

interface Props {
  open: boolean;
  phoneLabel: string;
  initialValue: string;
  busy: boolean;
  onOpenChange: (open: boolean) => void;
  onSave: (displayName: string) => void;
}

export function EditIdentityNameDialog({ open, phoneLabel, initialValue, busy, onOpenChange, onSave }: Props) {
  const [value, setValue] = useState(initialValue);

  useEffect(() => {
    if (open) setValue(initialValue);
  }, [open, initialValue]);

  const trimmed = value.trim();
  const canSave = trimmed !== '' && !busy;

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!busy) onOpenChange(o); }}>
      <DialogContent dir="rtl" className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>עריכת שם תצוגה</DialogTitle>
        </DialogHeader>
        <div className="space-y-3">
          <Label htmlFor="identity-name-input" className="text-start text-sm font-medium">
            {phoneLabel}
          </Label>
          <Input
            id="identity-name-input"
            value={value}
            onChange={(e) => setValue(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter' && canSave) onSave(trimmed); }}
            className="h-10"
            maxLength={120}
            disabled={busy}
            autoFocus
          />
        </div>
        <DialogFooter className="gap-2">
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={busy}>ביטול</Button>
          <Button onClick={() => onSave(trimmed)} disabled={!canSave}>
            {busy ? 'שומר…' : 'שמור'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
