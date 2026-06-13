'use client';

import { useEffect, useMemo, useState } from 'react';
import { toast } from 'sonner';
import { X, User, Home, Info } from 'lucide-react';
import { Sheet, SheetContent, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Checkbox } from '@/components/ui/checkbox';
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
import { RESIDENT_TYPES, residentTypeLabel } from '@/lib/constants/contacts';
import type { Contact, ContactResidentType } from '@/lib/types/contacts';

interface Props {
  open: boolean;
  /** null → create mode; a contact → edit mode. */
  contact: Contact | null;
  canEdit: boolean;
  onOpenChange: (o: boolean) => void;
  onSaved: () => void;
}

interface FormState {
  apartment_number: string;
  resident_type: ContactResidentType;
  owner_name: string;
  owner_phone: string;
  owner_email: string;
  owner_is_primary_contact: boolean;
  tenant_name: string;
  tenant_phone: string;
  tenant_email: string;
  tenant_is_primary_contact: boolean;
  address: string;
  notes: string;
  tags: string[];
}

const EMPTY_FORM: FormState = {
  apartment_number: '',
  resident_type: 'owner',
  owner_name: '',
  owner_phone: '',
  owner_email: '',
  owner_is_primary_contact: true,
  tenant_name: '',
  tenant_phone: '',
  tenant_email: '',
  tenant_is_primary_contact: false,
  address: '',
  notes: '',
  tags: [],
};

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function fromContact(c: Contact): FormState {
  return {
    apartment_number: c.apartment_number,
    resident_type: c.resident_type,
    owner_name: c.owner_name ?? '',
    owner_phone: c.owner_phone ?? '',
    owner_email: c.owner_email ?? '',
    owner_is_primary_contact: c.owner_is_primary_contact,
    tenant_name: c.tenant_name ?? '',
    tenant_phone: c.tenant_phone ?? '',
    tenant_email: c.tenant_email ?? '',
    tenant_is_primary_contact: c.tenant_is_primary_contact,
    address: c.address ?? '',
    notes: c.notes ?? '',
    tags: [...c.tags],
  };
}

export function ContactFormPanel({ open, contact, canEdit, onOpenChange, onSaved }: Props) {
  const isEdit = !!contact;
  const [form, setForm] = useState<FormState>(EMPTY_FORM);
  const [initial, setInitial] = useState<FormState>(EMPTY_FORM);
  const [submitting, setSubmitting] = useState(false);
  const [confirmCloseOpen, setConfirmCloseOpen] = useState(false);
  const [touched, setTouched] = useState<Record<string, boolean>>({});
  const [tagInput, setTagInput] = useState('');

  useEffect(() => {
    if (open) {
      const init = contact ? fromContact(contact) : EMPTY_FORM;
      setForm(init);
      setInitial(init);
      setTouched({});
      setTagInput('');
      setSubmitting(false);
    }
  }, [open, contact]);

  function set<K extends keyof FormState>(key: K, value: FormState[K]) {
    setForm((prev) => ({ ...prev, [key]: value }));
  }
  function markTouched(key: keyof FormState) {
    setTouched((prev) => ({ ...prev, [key]: true }));
  }

  const errors = useMemo(() => {
    const e: Partial<Record<keyof FormState, string>> = {};
    if (!form.apartment_number.trim()) e.apartment_number = 'מספר דירה הוא שדה חובה';
    if (form.owner_phone.trim() && !validatePhone(form.owner_phone).valid) {
      e.owner_phone = validatePhone(form.owner_phone).error ?? 'מספר טלפון לא תקין';
    }
    if (form.tenant_phone.trim() && !validatePhone(form.tenant_phone).valid) {
      e.tenant_phone = validatePhone(form.tenant_phone).error ?? 'מספר טלפון לא תקין';
    }
    if (form.owner_email.trim() && !EMAIL_RE.test(form.owner_email.trim())) {
      e.owner_email = 'אימייל לא תקין';
    }
    if (form.tenant_email.trim() && !EMAIL_RE.test(form.tenant_email.trim())) {
      e.tenant_email = 'אימייל לא תקין';
    }
    return e;
  }, [form]);

  function errFor(key: keyof FormState): string | null {
    return touched[key] ? errors[key] ?? null : null;
  }

  const dirty = useMemo(() => JSON.stringify(form) !== JSON.stringify(initial), [form, initial]);
  const hasErrors = Object.keys(errors).length > 0;
  const canSubmit = canEdit && !hasErrors && !submitting;

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

  function addTag() {
    const t = tagInput.trim();
    if (t && !form.tags.includes(t)) set('tags', [...form.tags, t]);
    setTagInput('');
  }
  function removeTag(t: string) {
    set('tags', form.tags.filter((x) => x !== t));
  }

  async function handleSubmit() {
    if (!canSubmit) {
      setTouched({
        apartment_number: true, owner_phone: true, tenant_phone: true,
        owner_email: true, tenant_email: true,
      });
      return;
    }
    setSubmitting(true);
    try {
      const phone = (v: string) => (v.trim() ? validatePhone(v).normalized : '');
      const body: Record<string, unknown> = {
        resident_type: form.resident_type,
        owner_name: form.owner_name.trim(),
        owner_phone: phone(form.owner_phone),
        owner_email: form.owner_email.trim(),
        owner_is_primary_contact: form.owner_is_primary_contact,
        tenant_name: form.tenant_name.trim(),
        tenant_phone: phone(form.tenant_phone),
        tenant_email: form.tenant_email.trim(),
        tenant_is_primary_contact: form.tenant_is_primary_contact,
        address: form.address.trim(),
        notes: form.notes.trim(),
        tags: form.tags,
      };
      if (!isEdit) body.apartment_number = form.apartment_number.trim();

      const url = isEdit ? `/api/contacts/${contact!.id}` : '/api/contacts';
      const method = isEdit ? 'PATCH' : 'POST';
      const r = await fetch(url, {
        method,
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify(body),
      });
      const data = (await r.json().catch(() => ({}))) as { error?: string };
      if (!r.ok) {
        const msg =
          data.error === 'apartment_number_exists' ? 'מספר דירה כבר קיים' :
          data.error === 'invalid_phone' ? 'מספר טלפון לא תקין' :
          data.error === 'invalid_email' ? 'אימייל לא תקין' :
          isEdit ? 'עדכון הדייר נכשל' : 'יצירת הדייר נכשלה';
        throw new Error(msg);
      }
      toast.success(isEdit ? 'הדייר עודכן' : 'הדייר נוצר');
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
          className="w-full p-0 sm:w-[55vw] md:min-w-[720px] flex flex-col gap-0 overflow-hidden bg-white"
        >
          <SheetHeader className="flex-none gap-2 bg-gradient-to-bl from-slate-900 via-blue-950 to-blue-900 px-6 py-6 text-white">
            <div className="flex items-start justify-between gap-4">
              <div className="min-w-0 flex-1">
                <SheetTitle className="text-2xl font-bold text-white">
                  {isEdit ? `עריכת דייר — דירה ${contact!.apartment_number}` : 'דייר חדש'}
                </SheetTitle>
                <p className="mt-1 text-sm text-white/70">
                  {canEdit
                    ? 'פרטי הדייר. שדות ידניים (הערות, תגיות) לא נדרסים בייבוא Excel.'
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
              {/* Top: apartment + resident type */}
              <Section title="פרטי הדירה" icon={Home} iconTone="blue">
                <div className="space-y-4 py-2">
                  <Field
                    id="contact-apartment"
                    label="מספר דירה"
                    required
                    value={form.apartment_number}
                    onChange={(v) => set('apartment_number', v)}
                    onBlur={() => markTouched('apartment_number')}
                    error={errFor('apartment_number')}
                    disabled={disabled || isEdit}
                    dir="ltr"
                    tabularNums
                    autoFocus={!isEdit}
                  />
                  <div className="space-y-2">
                    <Label className="text-base font-medium text-muted-foreground">סוג דייר</Label>
                    <Select
                      value={form.resident_type}
                      onValueChange={(v) => { if (v) set('resident_type', v as ContactResidentType); }}
                      disabled={disabled}
                    >
                      <SelectTrigger className="w-full data-[size=default]:h-10">
                        <SelectValue placeholder="בחר סוג...">
                          {(value: string | null) =>
                            value ? residentTypeLabel(value as ContactResidentType) : null}
                        </SelectValue>
                      </SelectTrigger>
                      <SelectContent>
                        {RESIDENT_TYPES.map((t) => (
                          <SelectItem key={t.value} value={t.value}>{t.label}</SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                </div>
              </Section>

              {/* Owner */}
              <Section title="פרטי בעל הדירה" icon={User} iconTone="blue">
                <div className="space-y-4 py-2">
                  <Field id="owner-name" label="שם בעלים" value={form.owner_name}
                    onChange={(v) => set('owner_name', v)} disabled={disabled} />
                  <Field id="owner-phone" label="טלפון בעלים" value={form.owner_phone}
                    onChange={(v) => set('owner_phone', v)} onBlur={() => markTouched('owner_phone')}
                    error={errFor('owner_phone')} disabled={disabled}
                    dir="ltr" tabularNums inputMode="tel" placeholder="052-1234567" />
                  <Field id="owner-email" label="אימייל בעלים" type="email" value={form.owner_email}
                    onChange={(v) => set('owner_email', v)} onBlur={() => markTouched('owner_email')}
                    error={errFor('owner_email')} disabled={disabled}
                    dir="ltr" placeholder="owner@example.com" />
                  <CheckboxRow
                    id="owner-primary"
                    label="מקבל הודעות"
                    checked={form.owner_is_primary_contact}
                    onChange={(v) => set('owner_is_primary_contact', v)}
                    disabled={disabled}
                  />
                </div>
              </Section>

              {/* Tenant — only when resident_type is 'tenant' */}
              {form.resident_type === 'tenant' && (
                <Section title="פרטי השוכר" icon={User} iconTone="violet">
                  <div className="space-y-4 py-2">
                    <Field id="tenant-name" label="שם שוכר" value={form.tenant_name}
                      onChange={(v) => set('tenant_name', v)} disabled={disabled} />
                    <Field id="tenant-phone" label="טלפון שוכר" value={form.tenant_phone}
                      onChange={(v) => set('tenant_phone', v)} onBlur={() => markTouched('tenant_phone')}
                      error={errFor('tenant_phone')} disabled={disabled}
                      dir="ltr" tabularNums inputMode="tel" placeholder="052-1234567" />
                    <Field id="tenant-email" label="אימייל שוכר" type="email" value={form.tenant_email}
                      onChange={(v) => set('tenant_email', v)} onBlur={() => markTouched('tenant_email')}
                      error={errFor('tenant_email')} disabled={disabled}
                      dir="ltr" placeholder="tenant@example.com" />
                    <CheckboxRow
                      id="tenant-primary"
                      label="מקבל הודעות"
                      checked={form.tenant_is_primary_contact}
                      onChange={(v) => set('tenant_is_primary_contact', v)}
                      disabled={disabled}
                    />
                  </div>
                </Section>
              )}

              {/* Extra */}
              <Section title="פרטים נוספים" icon={Info} iconTone="slate">
                <div className="space-y-4 py-2">
                  <Field id="contact-address" label="כתובת" value={form.address}
                    onChange={(v) => set('address', v)} disabled={disabled} />
                  <div className="space-y-2">
                    <Label htmlFor="contact-notes" className="text-base font-medium text-muted-foreground">הערות</Label>
                    <Textarea id="contact-notes" value={form.notes}
                      onChange={(e) => set('notes', e.target.value)} disabled={disabled} className="min-h-24" />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="contact-tags" className="text-base font-medium text-muted-foreground">תגיות</Label>
                    {form.tags.length > 0 && (
                      <div className="flex flex-wrap gap-1.5">
                        {form.tags.map((t) => (
                          <span key={t} className="inline-flex items-center gap-1 rounded-full bg-slate-100 px-2.5 py-0.5 text-xs font-medium text-slate-700">
                            {t}
                            {!disabled && (
                              <button type="button" aria-label={`הסר ${t}`} onClick={() => removeTag(t)}
                                className="text-slate-400 transition-colors hover:text-red-500">
                                <X className="h-3 w-3" />
                              </button>
                            )}
                          </span>
                        ))}
                      </div>
                    )}
                    <Input
                      id="contact-tags"
                      value={tagInput}
                      onChange={(e) => setTagInput(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') { e.preventDefault(); addTag(); }
                      }}
                      disabled={disabled}
                      placeholder="הקלד תגית ולחץ Enter"
                      className="h-10"
                    />
                  </div>
                </div>
              </Section>
            </div>
          </div>

          <PanelFooter
            onClose={requestClose}
            onSave={handleSubmit}
            saveDisabled={!canSubmit}
            saveDisabledReason={!canEdit ? 'אין הרשאה — כניסה כצופה' : undefined}
            saveLabel={submitting ? 'שומר…' : isEdit ? 'שמור שינויים' : 'צור דייר'}
          />
        </SheetContent>
      </Sheet>

      <AlertDialog open={confirmCloseOpen} onOpenChange={setConfirmCloseOpen}>
        <AlertDialogContent dir="rtl">
          <AlertDialogHeader>
            <AlertDialogTitle>לצאת ללא שמירה?</AlertDialogTitle>
            <AlertDialogDescription>השינויים שביצעת לא יישמרו.</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>המשך עריכה</AlertDialogCancel>
            <AlertDialogAction onClick={confirmDiscardClose} className="bg-destructive text-white hover:bg-destructive/90">
              צא ללא שמירה
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}

function CheckboxRow({
  id, label, checked, onChange, disabled,
}: { id: string; label: string; checked: boolean; onChange: (v: boolean) => void; disabled?: boolean }) {
  return (
    <div className="flex items-center gap-2">
      <Checkbox id={id} checked={checked} onCheckedChange={(v) => onChange(v === true)} disabled={disabled} />
      <Label htmlFor={id} className="cursor-pointer text-sm font-medium text-slate-700">{label}</Label>
    </div>
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
        className={cn('h-10', tabularNums && 'tabular-nums', error && 'border-red-400 bg-red-50 focus-visible:ring-red-200')}
      />
      {error && <p className="text-[12px] font-semibold text-red-500 text-right">⚠️ {error}</p>}
    </div>
  );
}
