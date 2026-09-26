'use client';

import { useMemo, useState } from 'react';
import { Tag, X } from 'lucide-react';
import { toast } from 'sonner';
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
import { FIN_KIND_LABEL, type FinKind, type FinSection } from '@/lib/constants/finance';
import type { FinCategory } from '@/lib/types/finance';

// Create / edit one category — a Sheet, like every CREATE/EDIT in the system
// (DESIGN.md §12). `section` is fixed by where the sheet opens from (the
// operating card or the renovation-fund card) and never edited afterwards; in
// the fund an expense category is a "מטרה". Mount with a fresh `key` per open.
export function CategorySheet({
  open, kind, section, category, onOpenChange, onSaved,
}: {
  open: boolean;
  kind: FinKind;
  section: FinSection;
  category: FinCategory | null;
  onOpenChange: (o: boolean) => void;
  onSaved: (c: FinCategory) => void;
}) {
  const isEdit = category !== null;
  const isFund = section === 'renovation_fund';
  const isPurpose = isFund && kind === 'expense';
  const noun = isPurpose ? 'מטרה' : isFund ? 'סעיף הפקדה' : `סעיף ${FIN_KIND_LABEL[kind]}`;
  const initial = useMemo(
    () => ({
      name: category?.name ?? '',
      is_hot_water: category?.is_hot_water ?? false,
      is_active: category?.is_active ?? true,
    }),
    [category],
  );
  const [form, setForm] = useState(initial);
  const [touched, setTouched] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [serverError, setServerError] = useState<string | null>(null);
  const [confirmClose, setConfirmClose] = useState(false);

  const nameError = touched && !form.name.trim() ? (isPurpose ? 'שם המטרה הוא שדה חובה' : 'שם הסעיף הוא שדה חובה') : serverError;
  const dirty = JSON.stringify(form) !== JSON.stringify(initial);
  const canSubmit = !!form.name.trim() && !submitting;

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
      const url = isEdit ? `/api/finance/categories/${category.id}` : '/api/finance/categories';
      const body = isEdit
        ? { name: form.name.trim(), is_hot_water: form.is_hot_water, is_active: form.is_active }
        : { kind, section, name: form.name.trim(), is_hot_water: form.is_hot_water, is_active: form.is_active };
      const r = await fetch(url, {
        method: isEdit ? 'PATCH' : 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify(body),
      });
      const data = (await r.json().catch(() => ({}))) as { category?: FinCategory; error?: string };
      if (!r.ok || !data.category) {
        const msg = data.error ?? 'שמירה נכשלה';
        if (r.status === 409) setServerError(msg);
        throw new Error(msg);
      }
      toast.success(isEdit ? `${noun === 'מטרה' ? 'המטרה עודכנה' : 'הסעיף עודכן'}` : `${noun === 'מטרה' ? 'המטרה נוצרה' : 'הסעיף נוצר'}`);
      onSaved(data.category);
      onOpenChange(false);
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
                  {isEdit ? `עריכת ${noun}` : isPurpose ? 'מטרה חדשה' : `${noun} חדש`}
                </SheetTitle>
                <p className="mt-1 text-sm text-white/70">
                  {isFund
                    ? `${isPurpose ? 'מטרה' : 'סעיף'} של קרן השיפוצים. ${isPurpose ? 'מטרה שיש לה תנועות לא נמחקת — רק מושבתת.' : 'סעיף שיש לו שורות לא נמחק — רק מושבת.'}`
                    : 'שם ודגלים. סעיף שיש לו שורות לא נמחק — רק מושבת.'}
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
              <Section title={isPurpose ? 'פרטי המטרה' : 'פרטי הסעיף'} icon={Tag} iconTone={isFund ? 'violet' : kind === 'income' ? 'emerald' : 'rose'}>
                <div className="space-y-4 py-2">
                  <Field
                    id="fin-cat-name"
                    label={isPurpose ? 'שם המטרה' : 'שם הסעיף'}
                    value={form.name}
                    onChange={(v) => { setForm((f) => ({ ...f, name: v })); setServerError(null); }}
                    onBlur={() => setTouched(true)}
                    error={nameError}
                    required
                    autoFocus
                    placeholder={isPurpose ? 'למשל: שיפוץ הלובי' : isFund ? 'למשל: גבייה לקרן' : kind === 'income' ? 'למשל: דמי ניהול' : 'למשל: חשמל'}
                  />
                  {!isFund && (
                    <label className="flex cursor-pointer select-none items-center gap-3 text-sm text-slate-700">
                      <Switch checked={form.is_hot_water} onCheckedChange={(v) => setForm((f) => ({ ...f, is_hot_water: v }))} />
                      סעיף מים חמים
                    </label>
                  )}
                  {isEdit && (
                    <label className="flex cursor-pointer select-none items-center gap-3 text-sm text-slate-700">
                      <Switch checked={form.is_active} onCheckedChange={(v) => setForm((f) => ({ ...f, is_active: v }))} />
                      פעיל (מוצע בטופס ההזנה)
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
            saveLabel={submitting ? 'שומר…' : isEdit ? 'שמור שינויים' : isPurpose ? 'צור מטרה' : 'צור סעיף'}
          />
        </SheetContent>
      </Sheet>

      <AlertDialog open={confirmClose} onOpenChange={setConfirmClose}>
        <AlertDialogContent dir="rtl">
          <AlertDialogHeader>
            <AlertDialogTitle>לצאת ללא שמירה?</AlertDialogTitle>
            <AlertDialogDescription>השינויים שביצעת לא יישמרו.</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>המשך עריכה</AlertDialogCancel>
            <AlertDialogAction onClick={() => { setConfirmClose(false); onOpenChange(false); }} className="bg-destructive text-white hover:bg-destructive/90">
              צא ללא שמירה
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
