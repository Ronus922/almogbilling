'use client';

import { useMemo, useState } from 'react';
import { toast } from 'sonner';
import { Users, X } from 'lucide-react';
import { Sheet, SheetContent, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { Switch } from '@/components/ui/switch';
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Section } from '@/components/side-panel/Section';
import { PanelFooter } from '@/components/side-panel/PanelFooter';
import { Field } from '@/components/side-panel/Field';
import { useEscapeKey } from '@/lib/hooks/useEscapeKey';
import { validatePhone } from '@/lib/validation';
import { OWNER_PHONE_RULE_MESSAGE, e164ToLocal, toPortalE164 } from '@/lib/portal/phone';
import type { OwnerPhone } from '@/lib/types/portal';

// Add / edit one owner phone of an apartment — a Sheet, like every CREATE/EDIT
// in the system (DESIGN.md §12), even for two fields.
//
// The PHONE is immutable once saved: it is the roster's identity (the unique key
// with the apartment, and what the login log points at). Changing an owner's
// number = deactivate the old row and add the new one, which keeps the history
// readable. Editing therefore only touches the name and the active flag.
export function OwnerPhoneSheet({ open, apartmentNumber, row, onOpenChange, onSaved }: {
  open: boolean;
  apartmentNumber: string;
  /** null = add a new owner. */
  row: OwnerPhone | null;
  onOpenChange: (o: boolean) => void;
  onSaved: () => void;
}) {
  const isEdit = row !== null;
  const initial = useMemo(
    () => ({
      phone: row ? e164ToLocal(row.phone_e164) : '',
      owner_name: row?.owner_name ?? '',
      is_active: row?.is_active ?? true,
    }),
    [row],
  );
  const [form, setForm] = useState(initial);
  const [touched, setTouched] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [serverError, setServerError] = useState<string | null>(null);
  const [confirmClose, setConfirmClose] = useState(false);

  // Israeli mobile or a foreign E.164 — the code is delivered over WhatsApp, so
  // an Israeli landline row could never sign in. Same rule as the server's
  // (toPortalE164) and as the table's CHECK. validatePhone only adds its
  // friendlier messages for an Israeli spelling; a '+…' number is judged by
  // toPortalE164 alone.
  const phoneError = (() => {
    if (serverError) return serverError;
    if (!touched || isEdit) return null;
    const typed = form.phone.trim();
    if (!typed) return 'מספר טלפון הוא שדה חובה';
    if (!typed.startsWith('+')) {
      const v = validatePhone(typed);
      if (!v.valid) return v.error ?? 'מספר טלפון לא תקין';
    }
    if (!toPortalE164(typed)) return OWNER_PHONE_RULE_MESSAGE;
    return null;
  })();

  const dirty = JSON.stringify(form) !== JSON.stringify(initial);
  const canSubmit = !submitting && (isEdit ? dirty : !!toPortalE164(form.phone));

  useEscapeKey(open && !confirmClose, () => requestClose());
  useEscapeKey(confirmClose, () => setConfirmClose(false));

  function requestClose() {
    if (submitting) return;
    if (dirty) setConfirmClose(true);
    else onOpenChange(false);
  }

  async function save() {
    setTouched(true);
    if (!canSubmit) return;
    setSubmitting(true);
    setServerError(null);
    try {
      const url = `/api/apartments/${encodeURIComponent(apartmentNumber)}/owner-phones`;
      const res = await fetch(url, {
        method: isEdit ? 'PATCH' : 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify(
          isEdit
            ? { id: row.id, owner_name: form.owner_name.trim() || null, is_active: form.is_active }
            : { phone: form.phone.trim(), owner_name: form.owner_name.trim() || undefined },
        ),
      });
      const data = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) {
        const msg = data.error ?? 'שמירה נכשלה';
        if (res.status === 409 || res.status === 400) setServerError(msg);
        throw new Error(msg);
      }
      toast.success(isEdit ? 'הבעלים עודכן' : 'הבעלים נוסף');
      onSaved();
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setSubmitting(false);
    }
  }

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
                  {isEdit ? 'עריכת בעלים' : 'בעלים חדש'}
                </SheetTitle>
                <p className="mt-1 text-sm text-white/70">
                  דירה {apartmentNumber} — מספר טלפון שמורשה להיכנס לפורטל בעלי הדירות.
                  {isEdit && ' המספר עצמו אינו נערך: להחלפה — השבת את הקיים והוסף חדש.'}
                </p>
              </div>
              <button
                type="button"
                onClick={requestClose}
                aria-label="סגור"
                disabled={submitting}
                className="flex h-11 w-11 shrink-0 items-center justify-center rounded-lg border border-white/25 bg-white/5 text-white transition-colors hover:border-white/50 hover:bg-white/15 disabled:opacity-60"
              >
                <X className="h-5 w-5" />
              </button>
            </div>
          </SheetHeader>

          <div className="flex-1 overflow-y-auto bg-slate-50/60 p-5">
            <div className="space-y-4">
              <Section title="פרטי הבעלים" icon={Users} iconTone="blue">
                <div className="space-y-4 py-2">
                  <Field
                    id="owner-phone"
                    label="טלפון"
                    value={form.phone}
                    onChange={(v) => { setForm((f) => ({ ...f, phone: v })); setServerError(null); }}
                    onBlur={() => setTouched(true)}
                    error={phoneError}
                    required={!isEdit}
                    disabled={isEdit}
                    type="tel"
                    dir="ltr"
                    inputMode="tel"
                    tabularNums
                    placeholder="050-0000000"
                    autoFocus={!isEdit}
                    hint={isEdit ? undefined : 'נייד ישראלי, או מספר בינלאומי עם קידומת (למשל ‎+44…) — הקוד נשלח בוואטסאפ.'}
                  />
                  <Field
                    id="owner-name"
                    label="שם הבעלים"
                    value={form.owner_name}
                    onChange={(v) => setForm((f) => ({ ...f, owner_name: v }))}
                    placeholder="למשל: ישראל ישראלי"
                    hint="מוצג בעמודת «בעלים» בלוג ההתחברויות."
                    autoFocus={isEdit}
                  />
                  {isEdit && (
                    <label className="flex cursor-pointer select-none items-center gap-3 text-sm text-slate-700">
                      <Switch
                        checked={form.is_active}
                        onCheckedChange={(v) => setForm((f) => ({ ...f, is_active: v }))}
                      />
                      פעיל (מורשה להיכנס לפורטל)
                    </label>
                  )}
                </div>
              </Section>
            </div>
          </div>

          <PanelFooter
            onClose={requestClose}
            onSave={() => void save()}
            saveDisabled={!canSubmit}
            saveLabel={submitting ? 'שומר…' : isEdit ? 'שמור שינויים' : 'הוסף בעלים'}
          />
        </SheetContent>
      </Sheet>

      <AlertDialog open={confirmClose} onOpenChange={setConfirmClose}>
        <AlertDialogContent dir="rtl">
          <AlertDialogHeader>
            <AlertDialogTitle>האם לצאת ללא שמירה?</AlertDialogTitle>
            <AlertDialogDescription>השינויים שהזנת לא יישמרו.</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>ביטול</AlertDialogCancel>
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
