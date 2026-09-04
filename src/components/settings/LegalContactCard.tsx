'use client';

import { useEffect, useState } from 'react';
import { Scale, Pencil } from 'lucide-react';
import { toast } from 'sonner';
import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { EMPTY_LEGAL_CONTACT, type LegalContact } from '@/lib/validation/legalContact';
import { LegalContactPanel } from './LegalContactPanel';

/**
 * Settings → "עורך דין". The lawyer's address lives HERE (app_settings
 * 'legal_contact'), never in code — the legal-status change notification
 * reads it at send time. The card only shows the stored value; editing opens
 * a side panel (DESIGN.md §12: every edit is a Sheet, never inline/Dialog).
 */
export function LegalContactCard({ canEdit }: { canEdit: boolean }) {
  const [loading, setLoading] = useState(true);
  const [contact, setContact] = useState<LegalContact>(EMPTY_LEGAL_CONTACT);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const r = await fetch('/api/settings/legal-contact', { credentials: 'include' });
        if (!r.ok) throw new Error('failed');
        const d = (await r.json()) as Partial<LegalContact>;
        if (cancelled) return;
        setContact({
          email: typeof d.email === 'string' ? d.email : '',
          name: typeof d.name === 'string' ? d.name : '',
        });
      } catch {
        if (!cancelled) toast.error('טעינת פרטי עורך הדין נכשלה');
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, []);

  return (
    <Card className="ring-1 ring-slate-200/70 shadow-[0_1px_2px_rgba(15,23,42,0.04)] p-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex min-w-0 items-start gap-3">
          <span className="grid h-10 w-10 shrink-0 place-items-center rounded-full bg-amber-50 text-amber-700">
            <Scale className="h-5 w-5" />
          </span>
          <div className="min-w-0">
            <h2 className="text-lg font-bold text-slate-900">עורך דין</h2>
            <p className="mt-1 text-sm text-slate-500">
              הכתובת שמקבלת עדכון כשדירה עוברת לסטטוס משפטי
            </p>
          </div>
        </div>
        <Button
          type="button"
          variant="outline"
          onClick={() => setOpen(true)}
          disabled={loading || !canEdit}
          className="gap-2 px-4 py-2"
        >
          <Pencil className="h-4 w-4" />
          עריכה
        </Button>
      </div>

      <dl className="mt-6 grid gap-4 sm:grid-cols-2">
        <div className="rounded-lg bg-slate-50 p-4">
          <dt className="text-[12px] font-medium text-slate-500">שם</dt>
          <dd className="mt-1 text-base font-semibold text-slate-900">
            {loading ? '…' : contact.name || 'לא הוגדר'}
          </dd>
        </div>
        <div className="rounded-lg bg-slate-50 p-4">
          <dt className="text-[12px] font-medium text-slate-500">אימייל</dt>
          <dd className="mt-1 break-all text-base font-semibold text-slate-900">
            {loading
              ? '…'
              : contact.email
                ? <span dir="ltr" className="inline-block">{contact.email}</span>
                : 'לא הוגדר'}
          </dd>
        </div>
      </dl>

      <LegalContactPanel
        open={open}
        initial={contact}
        onOpenChange={setOpen}
        onSaved={setContact}
      />
    </Card>
  );
}
