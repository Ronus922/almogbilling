'use client';

import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { X, Package, Info } from 'lucide-react';
import { Sheet, SheetContent, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select';
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Section } from '@/components/side-panel/Section';
import { PanelFooter } from '@/components/side-panel/PanelFooter';
import { Field } from '@/components/side-panel/Field';
import { useEscapeKey } from '@/lib/hooks/useEscapeKey';
import { OWNER_TYPE_LABEL, PARKING_OWNER_TYPES } from '@/lib/constants/parking';
import type { ParkingOwnerType, StorageUnit } from '@/lib/types/parking';

// CREATE / EDIT of a storage unit. Sheet, not Dialog — same project rule as the
// spot panel. Deliberately narrower than the parking form: a storage unit has
// no size and no sale status (see migration 076).

interface Props {
  open: boolean;
  unit: StorageUnit | null;
  canEdit: boolean;
  defaultApartment?: string | null;
  onOpenChange: (o: boolean) => void;
  onSaved: () => void;
}

interface FormState {
  unit_number: string;
  owner_type: ParkingOwnerType;
  apartment_number: string;
  notes: string;
}

function initialForm(unit: StorageUnit | null, defaultApartment?: string | null): FormState {
  if (unit) {
    return {
      unit_number: unit.unit_number,
      owner_type: unit.owner_type,
      apartment_number: unit.apartment_number ?? '',
      notes: unit.notes ?? '',
    };
  }
  return {
    unit_number: '',
    owner_type: defaultApartment ? 'apartment' : 'developer',
    apartment_number: defaultApartment ?? '',
    notes: '',
  };
}

export function StorageUnitPanel({
  open, unit, canEdit, defaultApartment, onOpenChange, onSaved,
}: Props) {
  const isEdit = !!unit;
  const [form, setForm] = useState<FormState>(() => initialForm(unit, defaultApartment));
  const [submitting, setSubmitting] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [confirmClose, setConfirmClose] = useState(false);
  const [fieldError, setFieldError] = useState<{ field: keyof FormState; message: string } | null>(null);

  useEffect(() => {
    if (open) {
      setForm(initialForm(unit, defaultApartment));
      setDirty(false);
      setFieldError(null);
    }
  }, [open, unit, defaultApartment]);

  function set<K extends keyof FormState>(key: K, value: FormState[K]) {
    setForm((f) => ({ ...f, [key]: value }));
    setDirty(true);
    setFieldError((e) => (e && e.field === key ? null : e));
  }

  function requestClose() {
    if (dirty && !submitting) setConfirmClose(true);
    else onOpenChange(false);
  }
  useEscapeKey(open && !confirmClose, requestClose);

  const isApartment = form.owner_type === 'apartment';
  const canSubmit = canEdit && !submitting && form.unit_number.trim().length > 0
    && (!isApartment || form.apartment_number.trim().length > 0);

  async function handleSubmit() {
    if (!canSubmit) return;
    setSubmitting(true);
    setFieldError(null);
    try {
      const body = {
        unit_number: form.unit_number.trim(),
        owner_type: form.owner_type,
        apartment_number: isApartment ? form.apartment_number.trim() : '',
        notes: form.notes.trim(),
      };
      const res = await fetch(isEdit ? `/api/storage/${unit!.id}` : '/api/storage', {
        method: isEdit ? 'PATCH' : 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify(body),
      });
      const data = (await res.json().catch(() => ({}))) as { error?: string; code?: string };
      if (!res.ok) {
        if (data.code === 'unit_number_taken') {
          setFieldError({ field: 'unit_number', message: data.error ?? 'מספר המחסן כבר תפוס' });
        } else if (data.code === 'apartment_not_found' || data.code?.startsWith('apartment_number')) {
          setFieldError({ field: 'apartment_number', message: data.error ?? 'מספר דירה לא תקין' });
        }
        throw new Error(data.error ?? (isEdit ? 'עדכון המחסן נכשל' : 'יצירת המחסן נכשלה'));
      }
      toast.success(isEdit ? 'המחסן עודכן' : 'המחסן נוצר');
      onSaved();
      onOpenChange(false);
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setSubmitting(false);
    }
  }

  const disabled = submitting || !canEdit;

  return (
    <>
      <Sheet open={open} onOpenChange={(o) => { if (!o) requestClose(); else onOpenChange(o); }}>
        <SheetContent
          side="left"
          dir="rtl"
          showCloseButton={false}
          className="w-full max-w-full p-0 sm:w-[92vw] md:w-[80vw] lg:w-[55vw] lg:min-w-[720px] flex flex-col gap-0 overflow-hidden bg-white"
        >
          <SheetHeader className="flex-none gap-2 bg-gradient-to-bl from-slate-900 via-blue-950 to-blue-900 px-6 py-6 text-white">
            <div className="flex items-start justify-between gap-4">
              <div className="min-w-0 flex-1">
                <SheetTitle className="text-2xl font-bold text-white">
                  {isEdit ? `עריכת מחסן ${unit!.unit_number}` : 'מחסן חדש'}
                </SheetTitle>
                <p className="mt-1 text-sm text-white/70">
                  {canEdit
                    ? 'מספר מחסן שבוטל משתחרר וניתן להקצאה מחדש.'
                    : 'תצוגה בלבד — אין לך הרשאת עריכה.'}
                </p>
              </div>
              <button
                type="button"
                onClick={requestClose}
                aria-label="סגור"
                disabled={submitting}
                className="flex h-11 w-11 shrink-0 items-center justify-center rounded-lg border border-white/25 bg-white/5 text-white transition-colors hover:bg-white/15 hover:border-white/50 disabled:opacity-60"
              >
                <X className="h-5 w-5" />
              </button>
            </div>
          </SheetHeader>

          <div className="flex-1 overflow-y-auto bg-slate-50/60 p-5">
            <div className="space-y-4">
              <Section title="פרטי המחסן" icon={Package} iconTone="violet">
                <div className="space-y-4 py-2">
                  <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                    <Field
                      id="unit-number"
                      label="מספר מחסן"
                      value={form.unit_number}
                      onChange={(v) => set('unit_number', v)}
                      error={fieldError?.field === 'unit_number' ? fieldError.message : null}
                      required
                      disabled={disabled}
                      dir="ltr"
                      autoFocus={!isEdit}
                    />

                    <div className="space-y-2">
                      <Label htmlFor="unit-owner" className="text-base font-medium text-muted-foreground">
                        שיוך<span className="text-red-500"> *</span>
                      </Label>
                      <Select
                        value={form.owner_type}
                        onValueChange={(v) => {
                          if (!v) return;
                          const next = v as ParkingOwnerType;
                          set('owner_type', next);
                          if (next !== 'apartment') set('apartment_number', '');
                        }}
                        disabled={disabled}
                      >
                        <SelectTrigger id="unit-owner" className="w-full data-[size=default]:h-10">
                          <SelectValue placeholder="בחרו שיוך...">
                            {(value: string | null) =>
                              value ? OWNER_TYPE_LABEL[value as ParkingOwnerType] : null}
                          </SelectValue>
                        </SelectTrigger>
                        <SelectContent>
                          {PARKING_OWNER_TYPES.map((t) => (
                            <SelectItem key={t} value={t}>{OWNER_TYPE_LABEL[t]}</SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>
                  </div>

                  {isApartment && (
                    <Field
                      id="unit-apartment"
                      label="מספר דירה"
                      value={form.apartment_number}
                      onChange={(v) => set('apartment_number', v)}
                      error={fieldError?.field === 'apartment_number' ? fieldError.message : null}
                      required
                      disabled={disabled}
                      dir="ltr"
                      inputMode="numeric"
                      tabularNums
                      hint="הדירה חייבת להיות קיימת ברשימת הדיירים."
                    />
                  )}
                </div>
              </Section>

              <Section title="הערות" icon={Info} iconTone="slate">
                <div className="space-y-2 py-2">
                  <Textarea
                    value={form.notes}
                    onChange={(e) => set('notes', e.target.value)}
                    disabled={disabled}
                    placeholder="הערות חופשיות על המחסן..."
                    className="min-h-24"
                  />
                </div>
              </Section>
            </div>
          </div>

          <PanelFooter
            onClose={requestClose}
            onSave={() => void handleSubmit()}
            saveDisabled={!canSubmit}
            saveDisabledReason={!canEdit ? 'אין הרשאת עריכה' : undefined}
            saveLabel={isEdit ? 'שמור שינויים' : 'צור מחסן'}
          />
        </SheetContent>
      </Sheet>

      <AlertDialog open={confirmClose} onOpenChange={setConfirmClose}>
        <AlertDialogContent dir="rtl">
          <AlertDialogHeader>
            <AlertDialogTitle>האם לצאת ללא שמירה?</AlertDialogTitle>
            <AlertDialogDescription>השינויים שביצעת לא יישמרו.</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>המשך עריכה</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => { setConfirmClose(false); onOpenChange(false); }}
              className="bg-destructive text-white hover:bg-destructive/90"
            >
              צא ללא שמירה
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
