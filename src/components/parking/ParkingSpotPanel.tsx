'use client';

import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { X, SquareParking, Info } from 'lucide-react';
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
import {
  DEFAULT_LOT_CODE, OWNER_TYPE_LABEL, PARKING_OWNER_TYPES, PARKING_SALE_STATUSES,
  PARKING_SIZE_TYPES, SALE_STATUS_LABEL, SIZE_TYPE_LABEL,
} from '@/lib/constants/parking';
import type {
  ParkingOwnerType, ParkingSaleStatus, ParkingSizeType, ParkingSpot,
} from '@/lib/types/parking';

// CREATE / EDIT of a parking spot. A Sheet, never a Dialog — project rule:
// every entity create/edit is a side panel regardless of how short the form is.

interface Props {
  open: boolean;
  /** null → create mode; a spot → edit mode. */
  spot: ParkingSpot | null;
  canEdit: boolean;
  /** Pre-fills the apartment when created from an apartment context. */
  defaultApartment?: string | null;
  onOpenChange: (o: boolean) => void;
  onSaved: () => void;
}

interface FormState {
  spot_number: string;
  owner_type: ParkingOwnerType;
  apartment_number: string;
  size_type: ParkingSizeType;
  sale_status: ParkingSaleStatus;
  notes: string;
}

function initialForm(spot: ParkingSpot | null, defaultApartment?: string | null): FormState {
  if (spot) {
    return {
      spot_number: String(spot.spot_number),
      owner_type: spot.owner_type,
      apartment_number: spot.apartment_number ?? '',
      size_type: spot.size_type,
      sale_status: spot.sale_status,
      notes: spot.notes ?? '',
    };
  }
  return {
    spot_number: '',
    owner_type: defaultApartment ? 'apartment' : 'developer',
    apartment_number: defaultApartment ?? '',
    size_type: 'single',
    sale_status: 'none',
    notes: '',
  };
}

export function ParkingSpotPanel({
  open, spot, canEdit, defaultApartment, onOpenChange, onSaved,
}: Props) {
  const isEdit = !!spot;
  const [form, setForm] = useState<FormState>(() => initialForm(spot, defaultApartment));
  const [submitting, setSubmitting] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [confirmClose, setConfirmClose] = useState(false);
  /** Server-side field errors (conflict / unknown apartment) shown inline. */
  const [fieldError, setFieldError] = useState<{ field: keyof FormState; message: string } | null>(null);

  useEffect(() => {
    if (open) {
      setForm(initialForm(spot, defaultApartment));
      setDirty(false);
      setFieldError(null);
    }
  }, [open, spot, defaultApartment]);

  function set<K extends keyof FormState>(key: K, value: FormState[K]) {
    setForm((f) => ({ ...f, [key]: value }));
    setDirty(true);
    // Clear a server error for the field being corrected — leaving it up while
    // the user retypes reads as "still wrong" when it may no longer be.
    setFieldError((e) => (e && e.field === key ? null : e));
  }

  function requestClose() {
    if (dirty && !submitting) setConfirmClose(true);
    else onOpenChange(false);
  }
  useEscapeKey(open && !confirmClose, requestClose);

  const isApartment = form.owner_type === 'apartment';
  const spotNumberValid = /^\d+$/.test(form.spot_number.trim());
  const canSubmit = canEdit && !submitting && spotNumberValid
    && (!isApartment || form.apartment_number.trim().length > 0);

  async function handleSubmit() {
    if (!canSubmit) return;
    setSubmitting(true);
    setFieldError(null);
    try {
      const body = {
        // lot_code is preserved on edit and defaults on create — there is only
        // one lot today, so it is not a form field (see the section subtitle).
        lot_code: spot?.lot_code ?? DEFAULT_LOT_CODE,
        spot_number: form.spot_number.trim(),
        owner_type: form.owner_type,
        // The API rejects a stray apartment number on a non-apartment spot, so
        // it must be dropped here rather than sent and refused.
        apartment_number: isApartment ? form.apartment_number.trim() : '',
        size_type: form.size_type,
        sale_status: form.sale_status,
        notes: form.notes.trim(),
      };
      const res = await fetch(isEdit ? `/api/parking/${spot!.id}` : '/api/parking', {
        method: isEdit ? 'PATCH' : 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify(body),
      });
      const data = (await res.json().catch(() => ({}))) as {
        error?: string; code?: string; conflict?: { apartment_number: string | null };
      };
      if (!res.ok) {
        // A taken number and an unknown apartment are FIELD problems — showing
        // them only as a toast would leave the user staring at a form with no
        // indication of which input to fix.
        if (data.code === 'spot_number_taken') {
          setFieldError({ field: 'spot_number', message: data.error ?? 'מספר החניה כבר תפוס' });
        } else if (data.code === 'apartment_not_found') {
          setFieldError({ field: 'apartment_number', message: data.error ?? 'הדירה אינה קיימת' });
        } else if (data.code?.startsWith('apartment_number')) {
          setFieldError({ field: 'apartment_number', message: data.error ?? 'מספר דירה לא תקין' });
        }
        throw new Error(data.error ?? (isEdit ? 'עדכון החניה נכשל' : 'יצירת החניה נכשלה'));
      }
      toast.success(isEdit ? 'החניה עודכנה' : 'החניה נוצרה');
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
                  {isEdit ? `עריכת חניה ${spot!.spot_number}` : 'חניה חדשה'}
                </SheetTitle>
                <p className="mt-1 text-sm text-white/70">
                  {canEdit
                    ? 'חניה כפולה נשמרת כשורה אחת — בחרו את סוג הכפילות בשדה הגודל.'
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
              <Section
                title="פרטי החניה"
                icon={SquareParking}
                iconTone="blue"
                subtitle={`חניון ${spot?.lot_code ?? DEFAULT_LOT_CODE}`}
              >
                <div className="space-y-4 py-2">
                  <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                    <Field
                      id="spot-number"
                      label="מספר חניה"
                      value={form.spot_number}
                      onChange={(v) => set('spot_number', v.replace(/\D/g, ''))}
                      error={fieldError?.field === 'spot_number' ? fieldError.message : null}
                      required
                      disabled={disabled}
                      dir="ltr"
                      inputMode="numeric"
                      tabularNums
                      autoFocus={!isEdit}
                    />

                    <div className="space-y-2">
                      <Label htmlFor="spot-owner" className="text-base font-medium text-muted-foreground">
                        שיוך<span className="text-red-500"> *</span>
                      </Label>
                      <Select
                        value={form.owner_type}
                        onValueChange={(v) => {
                          if (!v) return;
                          const next = v as ParkingOwnerType;
                          set('owner_type', next);
                          // Leaving a stale apartment number behind would be
                          // rejected by the API; clear it as the type changes.
                          if (next !== 'apartment') set('apartment_number', '');
                        }}
                        disabled={disabled}
                      >
                        <SelectTrigger id="spot-owner" className="w-full data-[size=default]:h-10">
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
                      id="spot-apartment"
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

                  <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                    <div className="space-y-2">
                      <Label htmlFor="spot-size" className="text-base font-medium text-muted-foreground">
                        גודל
                      </Label>
                      <Select
                        value={form.size_type}
                        onValueChange={(v) => { if (v) set('size_type', v as ParkingSizeType); }}
                        disabled={disabled}
                      >
                        <SelectTrigger id="spot-size" className="w-full data-[size=default]:h-10">
                          <SelectValue placeholder="בחרו גודל...">
                            {(value: string | null) =>
                              value ? SIZE_TYPE_LABEL[value as ParkingSizeType] : null}
                          </SelectValue>
                        </SelectTrigger>
                        <SelectContent>
                          {PARKING_SIZE_TYPES.map((t) => (
                            <SelectItem key={t} value={t}>{SIZE_TYPE_LABEL[t]}</SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                      <p className="text-[12px] text-slate-500 text-start">
                        חניה כפולה נספרת כ-2 מקומות.
                      </p>
                    </div>

                    <div className="space-y-2">
                      <Label htmlFor="spot-sale" className="text-base font-medium text-muted-foreground">
                        סטטוס מכירה
                      </Label>
                      <Select
                        value={form.sale_status}
                        onValueChange={(v) => { if (v) set('sale_status', v as ParkingSaleStatus); }}
                        disabled={disabled}
                      >
                        <SelectTrigger id="spot-sale" className="w-full data-[size=default]:h-10">
                          <SelectValue placeholder="בחרו סטטוס...">
                            {(value: string | null) =>
                              value ? SALE_STATUS_LABEL[value as ParkingSaleStatus] : null}
                          </SelectValue>
                        </SelectTrigger>
                        <SelectContent>
                          {PARKING_SALE_STATUSES.map((t) => (
                            <SelectItem key={t} value={t}>
                              {t === 'none' ? 'ללא' : SALE_STATUS_LABEL[t]}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>
                  </div>
                </div>
              </Section>

              <Section title="הערות" icon={Info} iconTone="slate">
                <div className="space-y-2 py-2">
                  <Textarea
                    value={form.notes}
                    onChange={(e) => set('notes', e.target.value)}
                    disabled={disabled}
                    placeholder="הערות חופשיות על החניה..."
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
            saveLabel={isEdit ? 'שמור שינויים' : 'צור חניה'}
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
