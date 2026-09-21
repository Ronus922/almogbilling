'use client';

import { useMemo, useState } from 'react';
import { Tag, X } from 'lucide-react';
import { toast } from 'sonner';
import { Sheet, SheetContent, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Section } from '@/components/side-panel/Section';
import { PanelFooter } from '@/components/side-panel/PanelFooter';
import { Field } from '@/components/side-panel/Field';
import { useEscapeKey } from '@/lib/hooks/useEscapeKey';
import { FIN_KIND_LABEL, FIN_SECTION_LABEL, FIN_SECTIONS, type FinKind, type FinSection } from '@/lib/constants/finance';
import type { FinCategory } from '@/lib/types/finance';

// Create / edit one category — a Sheet, like every CREATE/EDIT in the system
// (DESIGN.md §12). Mount with a fresh `key` per open so the form resets.
export function CategorySheet({
  open, kind, category, onOpenChange, onSaved,
}: {
  open: boolean;
  kind: FinKind;
  category: FinCategory | null;
  onOpenChange: (o: boolean) => void;
  onSaved: (c: FinCategory) => void;
}) {
  const isEdit = category !== null;
  const initial = useMemo(
    () => ({
      name: category?.name ?? '',
      section: (category?.section ?? 'operating') as FinSection,
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

  const nameError = touched && !form.name.trim() ? 'שם הסעיף הוא שדה חובה' : serverError;
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
        ? { name: form.name.trim(), section: form.section, is_hot_water: form.is_hot_water, is_active: form.is_active }
        : { kind, name: form.name.trim(), section: form.section, is_hot_water: form.is_hot_water, is_active: form.is_active };
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
      toast.success(isEdit ? 'הסעיף עודכן' : 'הסעיף נוצר');
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
                  {isEdit ? `עריכת סעיף ${FIN_KIND_LABEL[kind]}` : `סעיף ${FIN_KIND_LABEL[kind]} חדש`}
                </SheetTitle>
                <p className="mt-1 text-sm text-white/70">שם, חלק בתקציב ודגלים. סעיף שיש לו שורות לא נמחק — רק מושבת.</p>
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
              <Section title="פרטי הסעיף" icon={Tag} iconTone={kind === 'income' ? 'emerald' : 'rose'}>
                <div className="space-y-4 py-2">
                  <Field
                    id="fin-cat-name"
                    label="שם הסעיף"
                    value={form.name}
                    onChange={(v) => { setForm((f) => ({ ...f, name: v })); setServerError(null); }}
                    onBlur={() => setTouched(true)}
                    error={nameError}
                    required
                    autoFocus
                    placeholder={kind === 'income' ? 'למשל: דמי ניהול' : 'למשל: חשמל'}
                  />
                  <div className="space-y-2">
                    <Label htmlFor="fin-cat-section" className="text-base font-medium text-muted-foreground">חלק בתקציב</Label>
                    <Select value={form.section} onValueChange={(v) => { if (v) setForm((f) => ({ ...f, section: v as FinSection })); }}>
                      <SelectTrigger id="fin-cat-section" className="w-full data-[size=default]:h-10">
                        <SelectValue>{(v: string | null) => (v ? FIN_SECTION_LABEL[v as FinSection] : null)}</SelectValue>
                      </SelectTrigger>
                      <SelectContent>
                        {FIN_SECTIONS.map((s) => (
                          <SelectItem key={s} value={s}>{FIN_SECTION_LABEL[s]}</SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    <p className="text-[12px] text-slate-500 text-start">קרן השיפוצים מוצגת בסקירה בנפרד מהתקציב השוטף.</p>
                  </div>
                  <label className="flex cursor-pointer select-none items-center gap-3 text-sm text-slate-700">
                    <Switch checked={form.is_hot_water} onCheckedChange={(v) => setForm((f) => ({ ...f, is_hot_water: v }))} />
                    סעיף מים חמים
                  </label>
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
            saveLabel={submitting ? 'שומר…' : isEdit ? 'שמור שינויים' : 'צור סעיף'}
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
