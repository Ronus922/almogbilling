'use client';

import { useEffect, useMemo, useState } from 'react';
import { toast } from 'sonner';
import {
  X, Building2, MapPin, CreditCard,
} from 'lucide-react';
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
import {
  SUPPLIER_TYPES, supplierTypeMeta, PAYMENT_TERMS, paymentTermsLabel,
} from '@/lib/constants/suppliers';
import type {
  SupplierWritableFields, SupplierPaymentTerms, SupplierCategory,
} from '@/lib/types/suppliers';

// Sentinel for "no category" — base-ui Select needs a non-empty value.
const NONE = '__none__';

interface Props {
  open: boolean;
  categories: SupplierCategory[];
  onOpenChange: (o: boolean) => void;
  onCreated: () => void;
}

interface FormState {
  display_name: string;
  company_name: string;
  supplier_type: string;
  category_id: string;
  contact_person: string;
  phone: string;
  mobile: string;
  email: string;
  address: string;
  city: string;
  website: string;
  tax_id: string;
  notes: string;
  payment_terms: SupplierPaymentTerms;
  bank_name: string;
  bank_branch: string;
  bank_account: string;
}

const EMPTY_FORM: FormState = {
  display_name: '',
  company_name: '',
  supplier_type: 'general',
  category_id: NONE,
  contact_person: '',
  phone: '',
  mobile: '',
  email: '',
  address: '',
  city: '',
  website: '',
  tax_id: '',
  notes: '',
  payment_terms: 'immediate',
  bank_name: '',
  bank_branch: '',
  bank_account: '',
};

export function CreateSupplierPanel({ open, categories, onOpenChange, onCreated }: Props) {
  const [form, setForm] = useState<FormState>(EMPTY_FORM);
  const [submitting, setSubmitting] = useState(false);
  const [confirmCloseOpen, setConfirmCloseOpen] = useState(false);
  const [touched, setTouched] = useState<Record<string, boolean>>({});

  // Fresh form on every open.
  useEffect(() => {
    if (open) {
      setForm(EMPTY_FORM);
      setTouched({});
      setSubmitting(false);
    }
  }, [open]);

  function set<K extends keyof FormState>(key: K, value: FormState[K]) {
    setForm((prev) => ({ ...prev, [key]: value }));
  }

  function markTouched(key: keyof FormState) {
    setTouched((prev) => ({ ...prev, [key]: true }));
  }

  // Field-level errors (DESIGN.md §7 pattern). display_name required;
  // phone/mobile validated only when non-empty.
  const errors = useMemo(() => {
    const e: Partial<Record<keyof FormState, string>> = {};
    if (!form.display_name.trim()) e.display_name = 'שם תצוגה הוא שדה חובה';
    if (form.phone.trim() && !validatePhone(form.phone).valid) {
      e.phone = validatePhone(form.phone).error ?? 'מספר טלפון לא תקין';
    }
    if (form.mobile.trim() && !validatePhone(form.mobile).valid) {
      e.mobile = validatePhone(form.mobile).error ?? 'מספר טלפון לא תקין';
    }
    return e;
  }, [form.display_name, form.phone, form.mobile]);

  function errFor(key: keyof FormState): string | null {
    return touched[key] ? errors[key] ?? null : null;
  }

  const dirty = useMemo(
    () => JSON.stringify(form) !== JSON.stringify(EMPTY_FORM),
    [form],
  );

  const canSubmit = !errors.display_name && !errors.phone && !errors.mobile && !submitting;

  // Defensive ESC: panel listens unless the cancel-confirm dialog is open.
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
    // Reveal any pending field errors on a blocked submit.
    if (!canSubmit) {
      setTouched({ display_name: true, phone: true, mobile: true });
      return;
    }

    setSubmitting(true);
    try {
      const payload: SupplierWritableFields = {
        display_name: form.display_name.trim(),
        company_name: form.company_name.trim(),
        contact_person: form.contact_person.trim(),
        supplier_type: form.supplier_type,
        category_id: form.category_id === NONE ? null : form.category_id,
        status: 'active',
        phone: form.phone.trim() ? validatePhone(form.phone).normalized : '',
        mobile: form.mobile.trim() ? validatePhone(form.mobile).normalized : '',
        email: form.email.trim(),
        website: form.website.trim(),
        address: form.address.trim(),
        city: form.city.trim(),
        tax_id: form.tax_id.trim(),
        bank_name: form.bank_name.trim(),
        bank_branch: form.bank_branch.trim(),
        bank_account: form.bank_account.trim(),
        payment_terms: form.payment_terms,
        notes: form.notes.trim(),
        internal_notes: '',
        rating: null,
      };

      const r = await fetch('/api/suppliers', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify(payload),
      });
      const data = (await r.json().catch(() => ({}))) as { error?: string };
      if (!r.ok) throw new Error(data.error ?? 'יצירת הספק נכשלה');

      toast.success('הספק נוצר');
      setForm(EMPTY_FORM);
      setTouched({});
      onCreated();
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
                <SheetTitle className="text-2xl font-bold text-white">ספק חדש</SheetTitle>
                <p className="mt-1 text-sm text-white/70">
                  מלא את פרטי הספק. ניתן לערוך ולהוסיף מסמכים לאחר היצירה.
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
            <div className="space-y-4">
              {/* Section 1 — פרטי הספק */}
              <Section title="פרטי הספק" icon={Building2} iconTone="blue">
                <div className="space-y-4 py-2">
                  <Field
                    id="sup-display-name"
                    label="שם תצוגה"
                    required
                    value={form.display_name}
                    onChange={(v) => set('display_name', v)}
                    onBlur={() => markTouched('display_name')}
                    error={errFor('display_name')}
                    disabled={submitting}
                    autoFocus
                  />
                  <Field
                    id="sup-company-name"
                    label="שם החברה"
                    value={form.company_name}
                    onChange={(v) => set('company_name', v)}
                    disabled={submitting}
                  />
                  <div className="space-y-2">
                    <Label className="text-base font-medium text-muted-foreground">סוג ספק</Label>
                    <Select
                      value={form.supplier_type}
                      onValueChange={(v) => { if (v) set('supplier_type', v); }}
                      disabled={submitting}
                    >
                      <SelectTrigger className="w-full data-[size=default]:h-10">
                        <SelectValue placeholder="בחר סוג...">
                          {(value: string | null) => {
                            if (!value) return null;
                            const meta = supplierTypeMeta(value);
                            const Icon = meta.icon;
                            return (
                              <span className="inline-flex items-center gap-2">
                                <Icon className="h-4 w-4 text-slate-500" />
                                {meta.label}
                              </span>
                            );
                          }}
                        </SelectValue>
                      </SelectTrigger>
                      <SelectContent>
                        {SUPPLIER_TYPES.map((t) => {
                          const Icon = t.icon;
                          return (
                            <SelectItem key={t.value} value={t.value}>
                              <span className="inline-flex items-center gap-2">
                                <Icon className="h-4 w-4 text-slate-500" />
                                {t.label}
                              </span>
                            </SelectItem>
                          );
                        })}
                      </SelectContent>
                    </Select>
                  </div>
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
                    id="sup-contact-person"
                    label="איש קשר"
                    value={form.contact_person}
                    onChange={(v) => set('contact_person', v)}
                    disabled={submitting}
                  />
                  <Field
                    id="sup-phone"
                    label="טלפון"
                    value={form.phone}
                    onChange={(v) => set('phone', v)}
                    onBlur={() => markTouched('phone')}
                    error={errFor('phone')}
                    disabled={submitting}
                    inputMode="tel"
                    dir="ltr"
                    tabularNums
                    placeholder="03-1234567"
                  />
                  <Field
                    id="sup-mobile"
                    label="נייד"
                    value={form.mobile}
                    onChange={(v) => set('mobile', v)}
                    onBlur={() => markTouched('mobile')}
                    error={errFor('mobile')}
                    disabled={submitting}
                    inputMode="tel"
                    dir="ltr"
                    tabularNums
                    placeholder="052-1234567"
                  />
                  <Field
                    id="sup-email"
                    label="אימייל"
                    type="email"
                    value={form.email}
                    onChange={(v) => set('email', v)}
                    disabled={submitting}
                    dir="ltr"
                    placeholder="supplier@example.com"
                  />
                </div>
              </Section>

              {/* Section 2 — כתובת ופרטים נוספים */}
              <Section title="כתובת ופרטים נוספים" icon={MapPin} iconTone="slate">
                <div className="space-y-4 py-2">
                  <Field
                    id="sup-address"
                    label="כתובת"
                    value={form.address}
                    onChange={(v) => set('address', v)}
                    disabled={submitting}
                  />
                  <Field
                    id="sup-city"
                    label="עיר"
                    value={form.city}
                    onChange={(v) => set('city', v)}
                    disabled={submitting}
                  />
                  <Field
                    id="sup-website"
                    label="אתר אינטרנט"
                    value={form.website}
                    onChange={(v) => set('website', v)}
                    disabled={submitting}
                    dir="ltr"
                    placeholder="https://"
                  />
                  <Field
                    id="sup-tax-id"
                    label="ח.פ / עוסק מורשה"
                    value={form.tax_id}
                    onChange={(v) => set('tax_id', v)}
                    disabled={submitting}
                    dir="ltr"
                    tabularNums
                  />
                  <div className="space-y-2">
                    <Label htmlFor="sup-notes" className="text-base font-medium text-muted-foreground">הערות</Label>
                    <Textarea
                      id="sup-notes"
                      value={form.notes}
                      onChange={(e) => set('notes', e.target.value)}
                      disabled={submitting}
                      className="min-h-24"
                    />
                  </div>
                </div>
              </Section>

              {/* Section 3 — תנאי תשלום */}
              <Section title="תנאי תשלום" icon={CreditCard} iconTone="emerald">
                <div className="space-y-4 py-2">
                  <div className="space-y-2">
                    <Label className="text-base font-medium text-muted-foreground">תנאי תשלום</Label>
                    <Select
                      value={form.payment_terms}
                      onValueChange={(v) => { if (v) set('payment_terms', v as SupplierPaymentTerms); }}
                      disabled={submitting}
                    >
                      <SelectTrigger className="w-full data-[size=default]:h-10">
                        <SelectValue placeholder="בחר תנאי תשלום...">
                          {(value: string | null) => (value ? paymentTermsLabel(value) : null)}
                        </SelectValue>
                      </SelectTrigger>
                      <SelectContent>
                        {PAYMENT_TERMS.map((p) => (
                          <SelectItem key={p.value} value={p.value}>{p.label}</SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                  <Field
                    id="sup-bank-name"
                    label="שם הבנק"
                    value={form.bank_name}
                    onChange={(v) => set('bank_name', v)}
                    disabled={submitting}
                  />
                  <Field
                    id="sup-bank-branch"
                    label="סניף"
                    value={form.bank_branch}
                    onChange={(v) => set('bank_branch', v)}
                    disabled={submitting}
                    dir="ltr"
                    tabularNums
                  />
                  <Field
                    id="sup-bank-account"
                    label="מספר חשבון"
                    value={form.bank_account}
                    onChange={(v) => set('bank_account', v)}
                    disabled={submitting}
                    dir="ltr"
                    tabularNums
                  />
                </div>
              </Section>
            </div>
          </div>

          {/* Footer */}
          <PanelFooter
            onClose={requestClose}
            onSave={handleSubmit}
            saveDisabled={!canSubmit}
            saveLabel={submitting ? 'יוצר…' : 'צור ספק'}
          />
        </SheetContent>
      </Sheet>

      {/* Confirm cancel-create */}
      <AlertDialog open={confirmCloseOpen} onOpenChange={setConfirmCloseOpen}>
        <AlertDialogContent dir="rtl">
          <AlertDialogHeader>
            <AlertDialogTitle>לבטל יצירת ספק?</AlertDialogTitle>
            <AlertDialogDescription>
              השדות שמילאת יימחקו. ניתן להתחיל מחדש בכל עת.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>המשך עריכה</AlertDialogCancel>
            <AlertDialogAction
              onClick={confirmDiscardClose}
              className="bg-destructive text-white hover:bg-destructive/90"
            >
              בטל
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

/** Field-error pattern mirrors EditPhoneDialog / ResetPasswordForm (ring + message). */
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
