'use client';

// The suppliers of a request, chosen on its form: a multi-select (chips with an
// X, like the recipients of a mail), a name that is not in the list can be added
// as a chip of its own (it never enters the suppliers list) with a phone / e-mail
// to reach it, and the "send by" ticks — none by default. A chip whose supplier
// lacks the e-mail / phone for a ticked channel carries a warning; issuing is not
// blocked, that supplier is simply skipped when sending.

import { useMemo } from 'react';
import { Mail, MessageCircle } from 'lucide-react';
import { Label } from '@/components/ui/label';
import { Field } from '@/components/side-panel/Field';
import { MultiSelectPicker, type PickerOption } from '@/components/ui/MultiSelectPicker';
import { CheckRow } from './CheckRow';
import { EMAIL_RE, missingForChannels, partyFromSupplier, typedParty, type PartyDraft } from './recipients';
import type { SupplierBrief } from './types';

interface Props {
  parties: PartyDraft[];
  onParties: (next: PartyDraft[]) => void;
  sendEmail: boolean;
  sendWhatsapp: boolean;
  onSendEmail: (v: boolean) => void;
  onSendWhatsapp: (v: boolean) => void;
  suppliers: SupplierBrief[];
  /** An issued request: its suppliers are shown, not edited, and nothing is sent from here. */
  readOnly?: boolean;
  error?: string | null;
  /** Show the e-mail problems of hand-typed suppliers. */
  touched?: boolean;
  disabled?: boolean;
}

export function RecipientsField({
  parties, onParties, sendEmail, sendWhatsapp, onSendEmail, onSendWhatsapp, suppliers, readOnly, error, touched, disabled,
}: Props) {
  const options = useMemo<PickerOption[]>(() => {
    const warn = (p: PartyDraft) => missingForChannels(p, suppliers, sendEmail, sendWhatsapp);
    const picked = new Map(parties.map((p) => [p.key, p]));
    const listed = suppliers.map((s) => ({
      id: s.id, label: s.name, warn: picked.has(s.id) ? warn(picked.get(s.id)!) : null,
    }));
    const typed = parties.filter((p) => !p.supplierId).map((p) => ({ id: p.key, label: p.name, warn: warn(p) }));
    return [...typed, ...listed];
  }, [parties, suppliers, sendEmail, sendWhatsapp]);

  function change(ids: string[]) {
    const byKey = new Map(parties.map((p) => [p.key, p]));
    onParties(ids.flatMap((id) => {
      const have = byKey.get(id);
      if (have) return [have];
      const s = suppliers.find((x) => x.id === id);
      return s ? [partyFromSupplier(s)] : [];
    }));
  }

  /** A name equal to a listed supplier's IS that supplier; anything else is hand-typed. */
  function create(label: string) {
    const same = suppliers.find((s) => s.name.trim().toLowerCase() === label.toLowerCase());
    if (same) {
      if (!parties.some((p) => p.key === same.id)) onParties([...parties, partyFromSupplier(same)]);
      return;
    }
    onParties([...parties, typedParty(label)]);
  }

  function patch(key: string, next: Partial<PartyDraft>) {
    onParties(parties.map((p) => (p.key === key ? { ...p, ...next } : p)));
  }

  const typed = parties.filter((p) => !p.supplierId);

  if (readOnly) {
    return (
      <div className="space-y-2" data-rfq-suppliers>
        <Label className="text-base font-medium text-muted-foreground">ספקים</Label>
        <ul className="flex flex-wrap gap-1.5" data-rfq-suppliers-list>
          {parties.map((p) => (
            <li key={p.key} className="rounded-lg border border-slate-200 bg-white px-2.5 py-1 text-xs text-slate-600 shadow-sm">{p.name}</li>
          ))}
        </ul>
        <p className="text-[12px] text-slate-500">ספקי הבקשה נקבעים בהפקה ואינם ניתנים לשינוי אחריה.</p>
      </div>
    );
  }

  return (
    <div className="space-y-4" data-rfq-suppliers>
      <div className="space-y-2">
        <Label htmlFor="doc-suppliers" className="text-base font-medium text-muted-foreground">
          ספקים<span className="text-red-500"> *</span>
        </Label>
        <MultiSelectPicker
          id="doc-suppliers"
          options={options}
          selected={parties.map((p) => p.key)}
          onChange={change}
          onCreate={create}
          createLabel={(t) => `הוספת “${t}” כספק שאינו ברשימה`}
          placeholder="חיפוש ספק מהרשימה או הקלדת שם ספק"
          searchPlaceholder="חיפוש ספק או הקלדת שם"
          emptyText="לא נמצאו ספקים"
          disabled={disabled}
          invalid={!!error}
        />
        {error && <p className="text-[12px] font-semibold text-red-500 text-start">⚠️ {error}</p>}
        {!error && typed.length > 0 && (
          <p className="text-[12px] text-slate-500">ספק שאינו ברשימה — הפרטים נשמרים על הבקשה בלבד.</p>
        )}
      </div>

      {typed.map((p) => (
        <div key={p.key} className="grid gap-3 rounded-lg border border-line bg-white p-3 sm:grid-cols-2" data-typed-supplier={p.key}>
          <p className="text-sm font-semibold text-ink sm:col-span-2">{p.name}</p>
          <Field
            id={`typed-phone-${p.key}`} label="טלפון" value={p.phone} onChange={(v) => patch(p.key, { phone: v })}
            dir="ltr" inputMode="tel" disabled={disabled}
          />
          <Field
            id={`typed-email-${p.key}`} label="מייל" value={p.email} onChange={(v) => patch(p.key, { email: v })}
            dir="ltr" type="email" disabled={disabled}
            error={touched && p.email.trim() && !EMAIL_RE.test(p.email.trim()) ? 'כתובת מייל לא תקינה' : null}
          />
        </div>
      ))}

      <div className="space-y-2" data-send-by>
        <Label className="text-base font-medium text-muted-foreground">לשלוח ב:</Label>
        <CheckRow checked={sendEmail} onToggle={() => onSendEmail(!sendEmail)} disabled={disabled} name="מייל" className="min-h-12 flex-wrap">
          <Mail className="h-5 w-5 text-slate-500" aria-hidden />
          <span className="text-sm font-bold text-ink">מייל</span>
          <span className="text-sm text-slate-500">ה-PDF והקישור האישי מצורפים להודעה</span>
        </CheckRow>
        <CheckRow checked={sendWhatsapp} onToggle={() => onSendWhatsapp(!sendWhatsapp)} disabled={disabled} name="וואטסאפ" className="min-h-12 flex-wrap">
          <MessageCircle className="h-5 w-5 text-slate-500" aria-hidden />
          <span className="text-sm font-bold text-ink">וואטסאפ</span>
          <span className="text-sm text-slate-500">הודעה עם הקישור האישי + ה-PDF כקובץ</span>
        </CheckRow>
        <p className="text-[12px] text-slate-500">ללא סימון — המסמך יופק בלי שליחה. אפשר להוריד או להדפיס PDF לכל ספק מהטבלה</p>
      </div>
    </div>
  );
}
