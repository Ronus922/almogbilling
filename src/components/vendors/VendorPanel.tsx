'use client';

import { useEffect, useMemo, useState } from 'react';
import { toast } from 'sonner';
import { X, Building2, Phone as PhoneIcon, Loader2 } from 'lucide-react';
import { Sheet, SheetContent, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { Input } from '@/components/ui/input';
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
import { useEscapeKey } from '@/lib/hooks/useEscapeKey';
import { cn } from '@/lib/utils';
import { validatePhone } from '@/lib/validation';
import type { Vendor, VendorCategory, VendorWritableFields } from '@/lib/types/vendors';

// Sentinel for "no category" — base-ui Select needs a non-empty value.
const NONE = '__none__';
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

interface FormState {
  name: string;
  category_id: string;
  contact_person: string;
  phone: string;
  email: string;
  address: string;
  notes: string;
}

const EMPTY_FORM: FormState = {
  name: '',
  category_id: NONE,
  contact_person: '',
  phone: '',
  email: '',
  address: '',
  notes: '',
};

function toForm(v: Vendor): FormState {
  return {
    name: v.name,
    category_id: v.category_id ?? NONE,
    contact_person: v.contact_person,
    phone: v.phone,
    email: v.email,
    address: v.address,
    notes: v.notes,
  };
}

export function VendorPanel({
  open,
  vendorId,
  categories,
  onOpenChange,
  onSaved,
}: {
  open: boolean;
  /** null → create mode; otherwise edit that vendor. */
  vendorId: string | null;
  categories: VendorCategory[];
  onOpenChange: (o: boolean) => void;
  onSaved: () => void;
}) {
  const isEdit = vendorId !== null;
  const [form, setForm] = useState<FormState>(EMPTY_FORM);
  const [baseline, setBaseline] = useState<FormState>(EMPTY_FORM);
  const [loading, setLoading] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [confirmCloseOpen, setConfirmCloseOpen] = useState(false);
  const [touched, setTouched] = useState<Record<string, boolean>>({});

  // Load (edit) or reset (create) on open.
  useEffect(() => {
    if (!open) return;
    setTouched({});
    setSubmitting(false);
    setConfirmCloseOpen(false);
    if (!vendorId) {
      setForm(EMPTY_FORM);
      setBaseline(EMPTY_FORM);
      return;
    }
    let cancelled = false;
    setLoading(true);
    void (async () => {
      try {
        const r = await fetch(`/api/vendors/${vendorId}`, { credentials: 'include' });
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const data = (await r.json()) as { vendor: Vendor };
        if (cancelled) return;
        const f = toForm(data.vendor);
        setForm(f);
        setBaseline(f);
      } catch (err) {
        toast.error(`טעינת הספק נכשלה: ${(err as Error).message}`);
        onOpenChange(false);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [open, vendorId, onOpenChange]);

  function set<K extends keyof FormState>(key: K, value: FormState[K]) {
    setForm((prev) => ({ ...prev, [key]: value }));
  }

  function markTouched(key: keyof FormState) {
    setTouched((prev) => ({ ...prev, [key]: true }));
  }

  // Field-level errors (DESIGN.md §7). name required; phone/email validated when present.
  const errors = useMemo(() => {
    const e: Partial<Record<keyof FormState, string>> = {};
    if (!form.name.trim()) e.name = 'שם הספק הוא שדה חובה';
    if (form.phone.trim() && !validatePhone(form.phone).valid) {
      e.phone = validatePhone(form.phone).error ?? 'מספר טלפון לא תקין';
    }
    if (form.email.trim() && !EMAIL_RE.test(form.email.trim())) {
      e.email = 'כתובת אימייל לא תקינה';
    }
    return e;
  }, [form.name, form.phone, form.email]);

  function errFor(key: keyof FormState): string | null {
    return touched[key] ? errors[key] ?? null : null;
  }

  const dirty = useMemo(
    () => JSON.stringify(form) !== JSON.stringify(baseline),
    [form, baseline],
  );

  const canSubmit = !errors.name && !errors.phone && !errors.email && !submitting && !loading;

  useEscapeKey(open && !confirmCloseOpen, () => requestClose());
  useEscapeKey(confirmCloseOpen, () => setConfirmCloseOpen(false));

  function requestClose() {
    if (submitting) return;
    if (dirty) setConfirmCloseOpen(true);
    else onOpenChange(false);
  }

  function confirmDiscardClose() {
    setConfirmCloseOpen(false);
    onOpenChange(false);
  }

  async function handleSubmit() {
    if (!canSubmit) {
      setTouched({ name: true, phone: true, email: true });
      return;
    }
    setSubmitting(true);
    try {
      const payload: VendorWritableFields = {
        name: form.name.trim(),
        category_id: form.category_id === NONE ? null : form.category_id,
        contact_person: form.contact_person.trim(),
        phone: form.phone.trim() ? validatePhone(form.phone).normalized : '',
        email: form.email.trim(),
        address: form.address.trim(),
        notes: form.notes.trim(),
      };

      const r = await fetch(isEdit ? `/api/vendors/${vendorId}` : '/api/vendors', {
        method: isEdit ? 'PATCH' : 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify(payload),
      });
      const data = (await r.json().catch(() => ({}))) as { error?: string };
      if (!r.ok) throw new Error(data.error ?? (isEdit ? 'עדכון הספק נכשל' : 'יצירת הספק נכשלה'));

      toast.success(isEdit ? 'הספק עודכן' : 'הספק נוצר');
      onSaved();
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
          className="w-full p-0 sm:w-[55vw] md:min-w-[720px] flex flex-col gap-0 overflow-hidden bg-white"
        >
          {/* Header */}
          <SheetHeader className="flex-none gap-2 bg-gradient-to-bl from-slate-900 via-blue-950 to-blue-900 px-6 py-6 text-white">
            <div className="flex items-start justify-between gap-4">
              <div className="min-w-0 flex-1">
                <SheetTitle className="text-2xl font-bold text-white">
                  {isEdit ? 'עריכת ספק' : 'ספק חדש'}
                </SheetTitle>
                <p className="mt-1 text-sm text-white/70">
                  פרטי ספק השירות — שם, קטגוריה ודרכי יצירת קשר.
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

          {/* Body */}
          <div className="flex-1 overflow-y-auto bg-slate-50/60 p-5">
            {loading ? (
              <div className="flex items-center justify-center py-20 text-slate-400">
                <Loader2 className="h-6 w-6 animate-spin" />
              </div>
            ) : (
              <div className="space-y-4">
                <Section title="פרטי הספק" icon={Building2} iconTone="blue">
                  <div className="space-y-4 py-2">
                    <Field
                      id="vendor-name"
                      label="שם"
                      required
                      value={form.name}
                      onChange={(v) => set('name', v)}
                      onBlur={() => markTouched('name')}
                      error={errFor('name')}
                      disabled={submitting}
                      autoFocus
                    />
                    <div className="space-y-2">
                      <Label className="text-base font-medium text-muted-foreground">קטגוריה</Label>
                      <Select
                        value={form.category_id}
                        onValueChange={(v) => set('category_id', v ?? NONE)}
                        disabled={submitting}
                      >
                        <SelectTrigger className="w-full data-[size=default]:h-10">
                          <SelectValue placeholder="בחר קטגוריה...">
                            {(value: string | null) => {
                              if (!value || value === NONE) return 'ללא קטגוריה';
                              return categories.find((c) => c.id === value)?.name ?? 'קטגוריה';
                            }}
                          </SelectValue>
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value={NONE}>ללא קטגוריה</SelectItem>
                          {categories.map((c) => (
                            <SelectItem key={c.id} value={c.id}>{c.name}</SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>
                    <Field
                      id="vendor-contact"
                      label="איש קשר"
                      value={form.contact_person}
                      onChange={(v) => set('contact_person', v)}
                      disabled={submitting}
                    />
                  </div>
                </Section>

                <Section title="פרטי קשר" icon={PhoneIcon} iconTone="emerald">
                  <div className="space-y-4 py-2">
                    <Field
                      id="vendor-phone"
                      label="טלפון"
                      value={form.phone}
                      onChange={(v) => set('phone', v.replace(/[^\d\s+-]/g, ''))}
                      onBlur={() => {
                        markTouched('phone');
                        const v = validatePhone(form.phone.trim());
                        if (v.valid) set('phone', v.normalized);
                      }}
                      error={errFor('phone')}
                      disabled={submitting}
                      inputMode="tel"
                      dir="ltr"
                      tabularNums
                      placeholder="052-1234567"
                    />
                    <Field
                      id="vendor-email"
                      label="אימייל"
                      type="email"
                      value={form.email}
                      onChange={(v) => set('email', v)}
                      onBlur={() => markTouched('email')}
                      error={errFor('email')}
                      disabled={submitting}
                      dir="ltr"
                      placeholder="vendor@example.com"
                    />
                    <Field
                      id="vendor-address"
                      label="כתובת"
                      value={form.address}
                      onChange={(v) => set('address', v)}
                      disabled={submitting}
                    />
                    <div className="space-y-2">
                      <Label htmlFor="vendor-notes" className="text-base font-medium text-muted-foreground">הערות</Label>
                      <Textarea
                        id="vendor-notes"
                        value={form.notes}
                        onChange={(e) => set('notes', e.target.value)}
                        disabled={submitting}
                        className="min-h-24"
                      />
                    </div>
                  </div>
                </Section>
              </div>
            )}
          </div>

          {/* Footer */}
          <PanelFooter
            onClose={requestClose}
            onSave={handleSubmit}
            saveDisabled={!canSubmit}
            saveLabel={submitting ? 'שומר…' : isEdit ? 'שמור שינויים' : 'צור ספק'}
          />
        </SheetContent>
      </Sheet>

      {/* Confirm cancel with unsaved changes */}
      <AlertDialog open={confirmCloseOpen} onOpenChange={setConfirmCloseOpen}>
        <AlertDialogContent dir="rtl">
          <AlertDialogHeader>
            <AlertDialogTitle>לצאת בלי לשמור?</AlertDialogTitle>
            <AlertDialogDescription>
              יש שינויים שלא נשמרו. אם תצא עכשיו הם יאבדו.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>המשך עריכה</AlertDialogCancel>
            <AlertDialogAction
              onClick={confirmDiscardClose}
              className="bg-destructive text-white hover:bg-destructive/90"
            >
              צא בלי לשמור
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}

interface FieldProps {
  id: string;
  label: string;
  value: string;
  onChange: (v: string) => void;
  onBlur?: () => void;
  error?: string | null;
  required?: boolean;
  disabled?: boolean;
  type?: string;
  dir?: 'ltr' | 'rtl';
  inputMode?: React.HTMLAttributes<HTMLInputElement>['inputMode'];
  tabularNums?: boolean;
  placeholder?: string;
  autoFocus?: boolean;
}

/** Field-error pattern mirrors EditPhoneDialog / CreateSupplierPanel (ring + message). */
function Field({
  id, label, value, onChange, onBlur, error, required, disabled,
  type, dir, inputMode, tabularNums, placeholder, autoFocus,
}: FieldProps) {
  return (
    <div className="space-y-2">
      <Label htmlFor={id} className="text-base font-medium text-muted-foreground">
        {label}
        {required && <span className="text-red-500"> *</span>}
      </Label>
      <Input
        id={id}
        type={type}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onBlur={onBlur}
        disabled={disabled}
        dir={dir}
        inputMode={inputMode}
        placeholder={placeholder}
        autoFocus={autoFocus}
        className={cn(
          'h-10',
          tabularNums && 'tabular-nums',
          error && 'border-red-400 bg-red-50 focus-visible:ring-red-200',
        )}
      />
      {error && (
        <p className="text-[12px] font-semibold text-red-500 text-right">
          ⚠️ {error}
        </p>
      )}
    </div>
  );
}
