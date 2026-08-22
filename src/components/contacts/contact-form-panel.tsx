'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { toast } from 'sonner';
import { X, User, Home, Info, Plus, Trash2 } from 'lucide-react';
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
import { Field } from '@/components/side-panel/Field';
import { PanelFooter } from '@/components/side-panel/PanelFooter';
import { ContactAssetsSection, useContactAssets } from './contact-assets-section';
import { useEscapeKey } from '@/lib/hooks/useEscapeKey';
import { cn } from '@/lib/utils';
import { validatePhone } from '@/lib/validation';
import { computeManagementFee, MANAGEMENT_FEE_MULTIPLIER } from '@/lib/billing/managementFee';
import { RESIDENT_TYPES, residentTypeLabel } from '@/lib/constants/contacts';
import { UNIT_TYPE_LABEL } from '@/lib/constants/chips';
import type {
  Contact, ContactPersonRole, ContactResidentType, ContactUnitType,
} from '@/lib/types/contacts';

/** contacts.unit_type options, in display order (labels from the chips vocabulary). */
const UNIT_TYPES: readonly ContactUnitType[] = [
  'apartment', 'storage', 'parking', 'common', 'staff', 'other',
];

interface Props {
  open: boolean;
  /** null → create mode; a contact → edit mode. */
  contact: Contact | null;
  canEdit: boolean;
  /** parking:view — false hides the חניות ומחסנים section entirely (viewers). */
  canViewParking: boolean;
  /** parking:edit — false renders that section read-only. */
  canEditParking: boolean;
  onOpenChange: (o: boolean) => void;
  onSaved: () => void;
}

/**
 * One EXTRA owner/tenant row in the form. The first owner and the first tenant
 * live in the flat owner_* / tenant_* fields below (unchanged, still the ones
 * every existing screen reads); rows here are person #2 onward of each role and
 * persist in public.contact_people. `key` is client-only (stable React key).
 */
interface PersonRow {
  key: string;
  role: ContactPersonRole;
  name: string;
  phone: string;
  email: string;
  is_primary_contact: boolean;
}

interface FormState {
  apartment_number: string;
  apartment_size_sqm: string;
  management_fee: string;
  people: PersonRow[];
  resident_type: ContactResidentType;
  unit_type: ContactUnitType;
  owner_name: string;
  owner_phone: string;
  owner_email: string;
  owner_is_primary_contact: boolean;
  tenant_name: string;
  tenant_phone: string;
  tenant_email: string;
  tenant_is_primary_contact: boolean;
  operator_name: string;
  operator_phone: string;
  address: string;
  notes: string;
  tags: string[];
}

const EMPTY_FORM: FormState = {
  apartment_number: '',
  apartment_size_sqm: '',
  management_fee: '',
  people: [],
  resident_type: 'owner',
  unit_type: 'apartment',
  owner_name: '',
  owner_phone: '',
  owner_email: '',
  owner_is_primary_contact: true,
  tenant_name: '',
  tenant_phone: '',
  tenant_email: '',
  tenant_is_primary_contact: false,
  operator_name: '',
  operator_phone: '',
  address: '',
  notes: '',
  tags: [],
};

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Number → input string ('' for "not set", so a blank field stays blank). */
function numToStr(v: number | null): string {
  return v === null || v === undefined ? '' : String(v);
}

function fromContact(c: Contact): FormState {
  return {
    apartment_number: c.apartment_number,
    apartment_size_sqm: numToStr(c.apartment_size_sqm),
    management_fee: numToStr(c.management_fee),
    people: (c.people ?? []).map((p, i) => ({
      key: `saved-${p.id ?? i}`,
      role: p.role,
      name: p.name ?? '',
      phone: p.phone ?? '',
      email: p.email ?? '',
      is_primary_contact: p.is_primary_contact,
    })),
    resident_type: c.resident_type,
    unit_type: c.unit_type ?? 'apartment',
    owner_name: c.owner_name ?? '',
    owner_phone: c.owner_phone ?? '',
    owner_email: c.owner_email ?? '',
    owner_is_primary_contact: c.owner_is_primary_contact,
    tenant_name: c.tenant_name ?? '',
    tenant_phone: c.tenant_phone ?? '',
    tenant_email: c.tenant_email ?? '',
    tenant_is_primary_contact: c.tenant_is_primary_contact,
    operator_name: c.operator_name ?? '',
    operator_phone: c.operator_phone ?? '',
    address: c.address ?? '',
    notes: c.notes ?? '',
    tags: [...c.tags],
  };
}

export function ContactFormPanel({
  open, contact, canEdit, canViewParking, canEditParking, onOpenChange, onSaved,
}: Props) {
  const isEdit = !!contact;
  const [form, setForm] = useState<FormState>(EMPTY_FORM);
  const [initial, setInitial] = useState<FormState>(EMPTY_FORM);
  const [submitting, setSubmitting] = useState(false);
  const [confirmCloseOpen, setConfirmCloseOpen] = useState(false);
  const [touched, setTouched] = useState<Record<string, boolean>>({});
  const [tagInput, setTagInput] = useState('');
  // Monotonic source of stable keys for newly added person rows.
  const rowSeq = useRef(0);
  // Management-fee rate per m² (settings). null = not configured → the fee field
  // stays a plain manual input, exactly as before the rate existed.
  const [feePerSqm, setFeePerSqm] = useState<number | null>(null);

  // Parking & storage live in their own tables, reached through their own API.
  // The apartment number is the only link, so in create mode the section binds
  // to whatever is being typed and the rows are written once the tenant exists.
  const assetApartment = (contact?.apartment_number ?? form.apartment_number).trim();
  const assets = useContactAssets({
    open,
    enabled: canViewParking,
    apartmentNumber: assetApartment,
    isEdit,
  });

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

  // Load the per-m² rate whenever the panel opens (it may have changed in
  // Settings since the last open). Silent on failure → manual fee field.
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    (async () => {
      try {
        const r = await fetch('/api/settings/billing', { credentials: 'include' });
        if (!r.ok) return;
        const d = (await r.json()) as { managementFeePerSqm: number | null };
        if (!cancelled) setFeePerSqm(d.managementFeePerSqm);
      } catch {
        /* keep the fee field manual */
      }
    })();
    return () => { cancelled = true; };
  }, [open]);

  function set<K extends keyof FormState>(key: K, value: FormState[K]) {
    setForm((prev) => ({ ...prev, [key]: value }));
  }
  function markTouched(key: string) {
    setTouched((prev) => ({ ...prev, [key]: true }));
  }

  // ── Extra owners/tenants (unlimited, per role) ──────────────────────────
  function addPerson(role: ContactPersonRole) {
    rowSeq.current += 1;
    setForm((prev) => ({
      ...prev,
      people: [
        ...prev.people,
        { key: `new-${rowSeq.current}`, role, name: '', phone: '', email: '', is_primary_contact: true },
      ],
    }));
  }
  function updatePerson(key: string, patch: Partial<Omit<PersonRow, 'key' | 'role'>>) {
    setForm((prev) => ({
      ...prev,
      people: prev.people.map((p) => (p.key === key ? { ...p, ...patch } : p)),
    }));
  }
  function removePerson(key: string) {
    setForm((prev) => ({ ...prev, people: prev.people.filter((p) => p.key !== key) }));
  }
  const peopleOf = (role: ContactPersonRole) => form.people.filter((p) => p.role === role);

  /** Per-row phone/email errors, keyed by the row's client key. */
  const peopleErrors = useMemo(() => {
    const map = new Map<string, { phone?: string; email?: string }>();
    for (const p of form.people) {
      const e: { phone?: string; email?: string } = {};
      if (p.phone.trim() && !validatePhone(p.phone).valid) {
        e.phone = validatePhone(p.phone).error ?? 'מספר טלפון לא תקין';
      }
      if (p.email.trim() && !EMAIL_RE.test(p.email.trim())) e.email = 'אימייל לא תקין';
      if (e.phone || e.email) map.set(p.key, e);
    }
    return map;
  }, [form.people]);

  const errors = useMemo(() => {
    const e: Partial<Record<keyof FormState, string>> = {};
    if (!form.apartment_number.trim()) e.apartment_number = 'מספר דירה הוא שדה חובה';
    if (form.owner_phone.trim() && !validatePhone(form.owner_phone).valid) {
      e.owner_phone = validatePhone(form.owner_phone).error ?? 'מספר טלפון לא תקין';
    }
    if (form.tenant_phone.trim() && !validatePhone(form.tenant_phone).valid) {
      e.tenant_phone = validatePhone(form.tenant_phone).error ?? 'מספר טלפון לא תקין';
    }
    if (form.operator_phone.trim() && !validatePhone(form.operator_phone).valid) {
      e.operator_phone = validatePhone(form.operator_phone).error ?? 'מספר טלפון לא תקין';
    }
    if (form.owner_email.trim() && !EMAIL_RE.test(form.owner_email.trim())) {
      e.owner_email = 'אימייל לא תקין';
    }
    if (form.tenant_email.trim() && !EMAIL_RE.test(form.tenant_email.trim())) {
      e.tenant_email = 'אימייל לא תקין';
    }
    for (const key of ['apartment_size_sqm', 'management_fee'] as const) {
      const raw = form[key].trim();
      if (!raw) continue;
      const n = Number(raw);
      if (!Number.isFinite(n) || n < 0) e[key] = 'יש להזין מספר חיובי';
    }
    return e;
  }, [form]);

  function errFor(key: keyof FormState): string | null {
    return touched[key] ? errors[key] ?? null : null;
  }

  // Derived management fee: size × 150% × rate. null when either input is
  // missing — then the stored/typed value stands untouched.
  const sizeNum = form.apartment_size_sqm.trim() === '' ? null : Number(form.apartment_size_sqm);
  const derivedFee = computeManagementFee(
    sizeNum !== null && Number.isFinite(sizeNum) ? sizeNum : null,
    feePerSqm,
  );
  const feeIsDerived = feePerSqm !== null;

  const formDirty = useMemo(() => JSON.stringify(form) !== JSON.stringify(initial), [form, initial]);
  const dirty = formDirty || assets.dirty;
  const hasErrors = Object.keys(errors).length > 0 || peopleErrors.size > 0;
  // A manager may hold parking:edit without contacts:edit — then the tenant
  // fields stay read-only but the assets section is still theirs to save.
  const assetsEditable = canViewParking && canEditParking;
  // Asset errors only block the save of someone who can actually fix them.
  const canSubmit = (canEdit || assetsEditable) && !hasErrors
    && !(assetsEditable && assets.blocking) && !submitting;

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
        operator_phone: true, owner_email: true, tenant_email: true,
      });
      return;
    }
    setSubmitting(true);
    let contactSaved = false;
    try {
      const phone = (v: string) => (v.trim() ? validatePhone(v).normalized : '');
      const num = (v: string) => (v.trim() ? Number(v.trim()) : null);
      const body: Record<string, unknown> = {
        apartment_size_sqm: num(form.apartment_size_sqm),
        // Derived when a rate is configured and a size exists (the server
        // recomputes it anyway); otherwise the field's own value.
        management_fee: derivedFee !== null ? derivedFee : num(form.management_fee),
        // Complete list — the server replaces the stored extra people with it.
        // Rows left entirely blank are dropped server-side.
        people: form.people.map((p) => ({
          role: p.role,
          name: p.name.trim(),
          phone: phone(p.phone),
          email: p.email.trim(),
          is_primary_contact: p.is_primary_contact,
        })),
        resident_type: form.resident_type,
        unit_type: form.unit_type,
        owner_name: form.owner_name.trim(),
        owner_phone: phone(form.owner_phone),
        owner_email: form.owner_email.trim(),
        owner_is_primary_contact: form.owner_is_primary_contact,
        tenant_name: form.tenant_name.trim(),
        tenant_phone: phone(form.tenant_phone),
        tenant_email: form.tenant_email.trim(),
        tenant_is_primary_contact: form.tenant_is_primary_contact,
        operator_name: form.operator_name.trim(),
        operator_phone: phone(form.operator_phone),
        address: form.address.trim(),
        notes: form.notes.trim(),
        tags: form.tags,
      };
      if (!isEdit) body.apartment_number = form.apartment_number.trim();

      // The tenant must exist before anything can point at its apartment
      // number, so the contact is saved FIRST and the assets follow. If the
      // assets fail the tenant is already saved — the panel stays open and says
      // so, rather than pretending the whole save was rolled back.
      if (canEdit) {
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
        contactSaved = true;
      }

      if (assetsEditable && assets.dirty) {
        const apartment = isEdit ? contact!.apartment_number : form.apartment_number.trim();
        try {
          await assets.flush(apartment);
        } catch {
          // The specific reason ("חניה 63 כבר מוצמדת לדירה 1234") is already on
          // the row that caused it — a toast repeating it would be the only
          // place the user sees it, and it would then disappear.
          throw new Error('שיוך החניות והמחסנים לא הושלם — הפרטים מסומנים בשורה הרלוונטית.');
        }
      }

      toast.success(isEdit ? 'הדייר עודכן' : 'הדייר נוצר');
      onSaved();
      onOpenChange(false);
    } catch (e) {
      toast.error((e as Error).message);
      // The list still has to catch up with a tenant that did save.
      if (contactSaved) onSaved();
    } finally {
      setSubmitting(false);
    }
  }

  const disabled = submitting || !canEdit;

  // The secondary-contact section is stored in the tenant_* fields, but its
  // labels follow the resident type: a 'tenant' shows "שוכר", an 'operator'
  // shows "מפעיל". It is hidden when the resident is the owner.
  const secondary =
    form.resident_type === 'operator'
      ? {
          title: 'פרטי המפעיל', name: 'שם מפעיל', phone: 'טלפון מפעיל', email: 'אימייל מפעיל',
          add: 'הוסף מפעיל', extraTitle: 'מפעיל נוסף', tone: 'amber' as const,
        }
      : {
          title: 'פרטי השוכר', name: 'שם שוכר', phone: 'טלפון שוכר', email: 'אימייל שוכר',
          add: 'הוסף שוכר', extraTitle: 'שוכר נוסף', tone: 'violet' as const,
        };

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
                  <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
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
                    <Field
                      id="contact-size"
                      label='גודל דירה (מ"ר)'
                      value={form.apartment_size_sqm}
                      onChange={(v) => set('apartment_size_sqm', v)}
                      onBlur={() => markTouched('apartment_size_sqm')}
                      error={errFor('apartment_size_sqm')}
                      disabled={disabled}
                      dir="ltr"
                      tabularNums
                      inputMode="decimal"
                      placeholder="85"
                    />
                    <Field
                      id="contact-management-fee"
                      label="דמי ניהול (₪)"
                      value={feeIsDerived ? (derivedFee !== null ? String(derivedFee) : '') : form.management_fee}
                      onChange={(v) => set('management_fee', v)}
                      onBlur={() => markTouched('management_fee')}
                      error={feeIsDerived ? null : errFor('management_fee')}
                      disabled={disabled || feeIsDerived}
                      dir="ltr"
                      tabularNums
                      inputMode="decimal"
                      placeholder={feeIsDerived ? 'יש להזין גודל דירה' : '450'}
                    />
                  </div>

                  {feeIsDerived && (
                    <p className="text-[12px] text-slate-500">
                      {derivedFee !== null ? (
                        <>
                          מחושב אוטומטית:{' '}
                          <span className="font-semibold tabular-nums">{form.apartment_size_sqm}</span> מ&quot;ר ×{' '}
                          {MANAGEMENT_FEE_MULTIPLIER * 100}% ×{' '}
                          <span className="font-semibold tabular-nums">{feePerSqm}</span> ₪ למ&quot;ר ={' '}
                          <span className="font-semibold tabular-nums">{derivedFee.toLocaleString('he-IL')}</span> ₪
                        </>
                      ) : (
                        <>
                          דמי הניהול מחושבים אוטומטית: גודל הדירה × {MANAGEMENT_FEE_MULTIPLIER * 100}% ×{' '}
                          <span className="font-semibold tabular-nums">{feePerSqm}</span> ₪ למ&quot;ר (מתוך ההגדרות).
                          הזן גודל דירה כדי לחשב.
                        </>
                      )}
                    </p>
                  )}
                  <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                    <div className="space-y-2">
                      <Label className="text-base font-medium text-muted-foreground">סוג יחידה</Label>
                      <Select
                        value={form.unit_type}
                        onValueChange={(v) => { if (v) set('unit_type', v as ContactUnitType); }}
                        disabled={disabled}
                      >
                        <SelectTrigger className="w-full data-[size=default]:h-10">
                          <SelectValue placeholder="בחר סוג...">
                            {(value: string | null) =>
                              value ? UNIT_TYPE_LABEL[value] ?? value : null}
                          </SelectValue>
                        </SelectTrigger>
                        <SelectContent>
                          {UNIT_TYPES.map((t) => (
                            <SelectItem key={t} value={t}>{UNIT_TYPE_LABEL[t]}</SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>
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
                </div>
              </Section>

              {/* Owner — the first owner + any number of additional owners */}
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

                  {peopleOf('owner').map((p, i) => (
                    <PersonCard
                      key={p.key}
                      row={p}
                      index={i}
                      title={`בעל דירה נוסף ${i + 2}`}
                      nameLabel="שם בעלים"
                      phoneLabel="טלפון בעלים"
                      emailLabel="אימייל בעלים"
                      errors={peopleErrors.get(p.key)}
                      disabled={disabled}
                      onChange={(patch) => updatePerson(p.key, patch)}
                      onRemove={() => removePerson(p.key)}
                    />
                  ))}

                  {!disabled && (
                    <div className="flex justify-end">
                      <AddPersonButton label="הוסף בעל דירה" onClick={() => addPerson('owner')} />
                    </div>
                  )}
                </div>
              </Section>

              {/* Secondary contact — shown for tenant OR operator; labels follow the type. */}
              {form.resident_type !== 'owner' && (
                <Section title={secondary.title} icon={User} iconTone={secondary.tone}>
                  <div className="space-y-4 py-2">
                    <Field id="tenant-name" label={secondary.name} value={form.tenant_name}
                      onChange={(v) => set('tenant_name', v)} disabled={disabled} />
                    <Field id="tenant-phone" label={secondary.phone} value={form.tenant_phone}
                      onChange={(v) => set('tenant_phone', v)} onBlur={() => markTouched('tenant_phone')}
                      error={errFor('tenant_phone')} disabled={disabled}
                      dir="ltr" tabularNums inputMode="tel" placeholder="052-1234567" />
                    <Field id="tenant-email" label={secondary.email} type="email" value={form.tenant_email}
                      onChange={(v) => set('tenant_email', v)} onBlur={() => markTouched('tenant_email')}
                      error={errFor('tenant_email')} disabled={disabled}
                      dir="ltr" placeholder="name@example.com" />
                    <CheckboxRow
                      id="tenant-primary"
                      label="מקבל הודעות"
                      checked={form.tenant_is_primary_contact}
                      onChange={(v) => set('tenant_is_primary_contact', v)}
                      disabled={disabled}
                    />

                    {peopleOf('tenant').map((p, i) => (
                      <PersonCard
                        key={p.key}
                        row={p}
                        index={i}
                        title={`${secondary.extraTitle} ${i + 2}`}
                        nameLabel={secondary.name}
                        phoneLabel={secondary.phone}
                        emailLabel={secondary.email}
                        errors={peopleErrors.get(p.key)}
                        disabled={disabled}
                        onChange={(patch) => updatePerson(p.key, patch)}
                        onRemove={() => removePerson(p.key)}
                      />
                    ))}

                    {!disabled && (
                      <div className="flex justify-end">
                        <AddPersonButton label={secondary.add} onClick={() => addPerson('tenant')} />
                      </div>
                    )}
                  </div>
                </Section>
              )}

              {/* Operator — the registry's dedicated operator_name/operator_phone columns. */}
              <Section title="מפעיל" icon={User} iconTone="amber">
                <div className="grid grid-cols-1 gap-4 py-2 sm:grid-cols-2">
                  <Field id="operator-name" label="מפעיל — שם" value={form.operator_name}
                    onChange={(v) => set('operator_name', v)} disabled={disabled} />
                  <Field id="operator-phone" label="מפעיל — טלפון" value={form.operator_phone}
                    onChange={(v) => set('operator_phone', v)} onBlur={() => markTouched('operator_phone')}
                    error={errFor('operator_phone')} disabled={disabled}
                    dir="ltr" tabularNums inputMode="tel" placeholder="052-1234567" />
                </div>
              </Section>

              {/* Parking & storage — rows of the parking module's own tables,
                  linked by apartment_number. Hidden outright without
                  parking:view, which is exactly the viewer role. */}
              {canViewParking && (
                <ContactAssetsSection
                  assets={assets}
                  apartmentNumber={assetApartment}
                  canEdit={canEditParking}
                  disabled={submitting}
                />
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
            saveDisabledReason={
              !canEdit && !assetsEditable ? 'אין הרשאה — כניסה כצופה'
                : assetsEditable && assets.blocking ? 'יש לתקן את שיוך החניות והמחסנים'
                : undefined
            }
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

/** Section-header "+ הוסף…" affordance (same treatment as the reminders editor). */
function AddPersonButton({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="inline-flex h-8 items-center gap-1 rounded-lg bg-blue-600 px-3 text-xs font-semibold text-white transition-colors hover:bg-blue-700"
    >
      <Plus className="h-3.5 w-3.5" /> {label}
    </button>
  );
}

interface PersonCardProps {
  row: PersonRow;
  index: number;
  title: string;
  nameLabel: string;
  phoneLabel: string;
  emailLabel: string;
  errors?: { phone?: string; email?: string };
  disabled?: boolean;
  onChange: (patch: Partial<Omit<PersonRow, 'key' | 'role'>>) => void;
  onRemove: () => void;
}

/**
 * One additional owner/tenant — same three fields + "מקבל הודעות" as the first
 * person of the role, in a bordered sub-card with its own remove button. Shared
 * by both sections (owners and tenants/operators) so there is one implementation.
 */
function PersonCard({
  row, index, title, nameLabel, phoneLabel, emailLabel, errors, disabled, onChange, onRemove,
}: PersonCardProps) {
  const idBase = `${row.role}-extra-${index}`;
  return (
    <div className="space-y-4 rounded-lg border border-slate-200 bg-white p-4">
      <div className="flex items-center justify-between gap-2">
        <h4 className="text-sm font-semibold text-slate-700">{title}</h4>
        {!disabled && (
          <button
            type="button"
            onClick={onRemove}
            aria-label={`הסר ${title}`}
            className="grid h-11 w-11 shrink-0 place-items-center rounded-lg text-slate-400 transition-colors hover:bg-rose-50 hover:text-rose-600"
          >
            <Trash2 className="h-4 w-4" />
          </button>
        )}
      </div>
      <Field id={`${idBase}-name`} label={nameLabel} value={row.name}
        onChange={(v) => onChange({ name: v })} disabled={disabled} />
      <Field id={`${idBase}-phone`} label={phoneLabel} value={row.phone}
        onChange={(v) => onChange({ phone: v })} error={errors?.phone ?? null} disabled={disabled}
        dir="ltr" tabularNums inputMode="tel" placeholder="052-1234567" />
      <Field id={`${idBase}-email`} label={emailLabel} type="email" value={row.email}
        onChange={(v) => onChange({ email: v })} error={errors?.email ?? null} disabled={disabled}
        dir="ltr" placeholder="name@example.com" />
      <CheckboxRow
        id={`${idBase}-primary`}
        label="מקבל הודעות"
        checked={row.is_primary_contact}
        onChange={(v) => onChange({ is_primary_contact: v })}
        disabled={disabled}
      />
    </div>
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
