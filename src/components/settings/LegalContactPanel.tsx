'use client';

import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { X, Scale } from 'lucide-react';
import { Sheet, SheetContent, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { Section } from '@/components/side-panel/Section';
import { Field } from '@/components/side-panel/Field';
import { PanelFooter } from '@/components/side-panel/PanelFooter';
import { useEscapeKey } from '@/lib/hooks/useEscapeKey';
import {
  LEGAL_CONTACT_NAME_MAX,
  normalizeLegalContact,
  type LegalContact,
  type LegalContactErrors,
} from '@/lib/validation/legalContact';

interface Props {
  open: boolean;
  /** The value currently stored — the form resets to it every time it opens. */
  initial: LegalContact;
  onOpenChange: (o: boolean) => void;
  onSaved: (saved: LegalContact) => void;
}

/**
 * Edit panel for Settings → "עורך דין" (DESIGN.md §12: every edit is a Sheet,
 * `side="left"`, 55vw on desktop). Two fields, both optional — clearing both
 * means no lawyer is notified. Validation is the same pure helper the API
 * route runs, so the panel never shows a different message than the server.
 */
export function LegalContactPanel({ open, initial, onOpenChange, onSaved }: Props) {
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [touched, setTouched] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (open) {
      setName(initial.name);
      setEmail(initial.email);
      setTouched(false);
      setSubmitting(false);
    }
  }, [open, initial]);

  const normalized = normalizeLegalContact({ name, email });
  const errors: LegalContactErrors = normalized.ok ? {} : normalized.errors;
  const dirty = normalized.ok
    ? normalized.value.name !== initial.name || normalized.value.email !== initial.email
    : true;

  useEscapeKey(open, () => requestClose());

  function requestClose() {
    if (submitting) return;
    onOpenChange(false);
  }

  async function handleSubmit() {
    if (!normalized.ok) {
      setTouched(true);
      return;
    }
    if (!dirty || submitting) return;
    setSubmitting(true);
    try {
      const res = await fetch('/api/settings/legal-contact', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify(normalized.value),
      });
      const data = (await res.json().catch(() => ({}))) as {
        error?: string;
        email?: string;
        name?: string;
      };
      if (!res.ok) throw new Error(data.error ?? 'שמירה נכשלה');

      const saved: LegalContact = {
        email: typeof data.email === 'string' ? data.email : normalized.value.email,
        name: typeof data.name === 'string' ? data.name : normalized.value.name,
      };
      toast.success('פרטי עורך הדין נשמרו');
      onSaved(saved);
      onOpenChange(false);
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setSubmitting(false);
    }
  }

  return (
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
              <SheetTitle className="text-2xl font-bold text-white">עריכת פרטי עורך הדין</SheetTitle>
              <p className="mt-1 text-sm text-white/70">
                הכתובת נשמרת בהגדרות ומשמשת את התראת שינוי הסטטוס המשפטי. השאר ריק כדי לא לשלוח.
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
          <Section title="פרטי עורך הדין" icon={Scale} iconTone="amber">
            <div className="space-y-5 py-2">
              <Field
                id="legal-contact-name"
                label="שם"
                value={name}
                onChange={setName}
                onBlur={() => setTouched(true)}
                error={touched ? errors.name : null}
                disabled={submitting}
                autoFocus
                placeholder="לדוגמה: עו״ד ישראל ישראלי"
                hint={`עד ${LEGAL_CONTACT_NAME_MAX} תווים`}
              />
              <Field
                id="legal-contact-email"
                label="אימייל"
                type="email"
                dir="ltr"
                value={email}
                onChange={setEmail}
                onBlur={() => setTouched(true)}
                error={touched ? errors.email : null}
                disabled={submitting}
                placeholder="lawyer@example.com"
                hint="מתווסף לנמעני ההתראה כשדירה עוברת לסטטוס משפטי. ריק = לא נשלח."
              />
            </div>
          </Section>
        </div>

        <PanelFooter
          onClose={requestClose}
          onSave={handleSubmit}
          saveDisabled={submitting || (normalized.ok && !dirty)}
          saveDisabledReason={normalized.ok && !dirty && !submitting ? 'אין שינויים לשמירה' : undefined}
          saveLabel={submitting ? 'שומר…' : 'שמור שינויים'}
        />
      </SheetContent>
    </Sheet>
  );
}
