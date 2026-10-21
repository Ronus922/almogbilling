'use client';

// The company letterhead ("נייר מכתבים") of the purchasing PDFs: name, tax id,
// address, phone, e-mail, website, VAT rate, a logo and a scanned signature.
// One Sheet, two uses: the one-time wizard that opens the first time a document
// is produced without details (`wizard`), and the settings editor behind the
// gear icon of the purchasing screen. Saved in app_settings (purchasing_company).

import { useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import { Building2, ImagePlus, Percent, Save, Trash2, X } from 'lucide-react';
import { Sheet, SheetContent, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { Label } from '@/components/ui/label';
import { Section } from '@/components/side-panel/Section';
import { Field } from '@/components/side-panel/Field';
import { PanelFooter } from '@/components/side-panel/PanelFooter';
import { useEscapeKey } from '@/lib/hooks/useEscapeKey';
import { DEFAULT_VAT_RATE, validateBrandImage, type CompanySettings } from '@/lib/purchasing/model';

export interface CompanyState {
  company: CompanySettings;
  complete: boolean;
  logo_url: string | null;
  signature_url: string | null;
}

interface Props {
  open: boolean;
  /** The first-time wizard: explains why it opened. */
  wizard: boolean;
  state: CompanyState;
  onOpenChange: (o: boolean) => void;
  /** Called with the saved state; the wizard continues to the document. */
  onSaved: (s: CompanyState) => void;
}

interface Form {
  name: string; tax_id: string; address: string; phone: string; email: string; website: string; vat_rate: string;
}

const toForm = (c: CompanySettings): Form => ({
  name: c.name, tax_id: c.tax_id, address: c.address, phone: c.phone, email: c.email, website: c.website,
  vat_rate: String(c.vat_rate ?? DEFAULT_VAT_RATE),
});

function ImagePicker({
  label, hint, url, busy, onPick, onRemove, id,
}: { label: string; hint: string; url: string | null; busy: boolean; onPick: (f: File) => void; onRemove: () => void; id: string }) {
  const input = useRef<HTMLInputElement>(null);
  return (
    <div className="space-y-2">
      <Label htmlFor={id} className="text-base font-medium text-muted-foreground">{label}</Label>
      <div className="flex items-center gap-3 rounded-lg border border-line bg-white p-3">
        <div className="grid h-16 w-28 shrink-0 place-items-center overflow-hidden rounded-md border border-dashed border-line-strong bg-surface-2">
          {url
            // eslint-disable-next-line @next/next/no-img-element -- served by the authenticated /api/files proxy
            ? <img src={url} alt={label} className="max-h-full max-w-full object-contain" />
            : <ImagePlus className="h-5 w-5 text-ink-3" aria-hidden />}
        </div>
        <div className="min-w-0 flex-1 space-y-1">
          <p className="text-xs text-ink-3">{hint}</p>
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              disabled={busy}
              onClick={() => input.current?.click()}
              className="inline-flex h-11 items-center rounded-lg border border-line px-4 text-sm font-semibold text-ink-2 hover:bg-slate-50 disabled:opacity-50"
            >
              {url ? 'החלפה' : 'העלאה'}
            </button>
            {url && (
              <button
                type="button"
                disabled={busy}
                onClick={onRemove}
                className="inline-flex h-11 items-center gap-1 rounded-lg px-3 text-sm font-semibold text-rose-600 hover:bg-rose-50 disabled:opacity-50"
              >
                <Trash2 className="h-4 w-4" /> הסרה
              </button>
            )}
          </div>
        </div>
        <input
          ref={input}
          id={id}
          type="file"
          accept=".png,.jpg,.jpeg,image/png,image/jpeg"
          hidden
          onChange={(e) => { const f = e.target.files?.[0]; if (f) onPick(f); e.target.value = ''; }}
        />
      </div>
    </div>
  );
}

export function CompanySheet({ open, wizard, state, onOpenChange, onSaved }: Props) {
  const [form, setForm] = useState<Form>(toForm(state.company));
  const [images, setImages] = useState({ logo: state.logo_url, signature: state.signature_url });
  const [touched, setTouched] = useState(false);
  const [saving, setSaving] = useState(false);
  const [busyImage, setBusyImage] = useState(false);

  useEffect(() => {
    if (!open) return;
    setForm(toForm(state.company));
    setImages({ logo: state.logo_url, signature: state.signature_url });
    setTouched(false);
  }, [open, state]);

  const set = <K extends keyof Form>(k: K, v: string) => setForm((f) => ({ ...f, [k]: v }));
  const vat = Number(form.vat_rate.replace(',', '.'));
  const errors = {
    name: touched && !form.name.trim() ? 'יש להזין שם חברה' : null,
    tax_id: touched && !form.tax_id.trim() ? 'יש להזין ח.פ.' : null,
    address: touched && !form.address.trim() ? 'יש להזין כתובת' : null,
    phone: touched && !form.phone.trim() ? 'יש להזין טלפון' : null,
    email: touched && !/^\S+@\S+\.\S+$/.test(form.email.trim()) ? 'כתובת מייל לא תקינה' : null,
    vat: touched && (!Number.isFinite(vat) || vat < 0 || vat > 100) ? 'שיעור מע״מ לא תקין' : null,
  };

  useEscapeKey(open, () => requestClose());
  function requestClose() { if (!saving && !busyImage) onOpenChange(false); }

  async function pickImage(kind: 'logo' | 'signature', file: File) {
    const err = validateBrandImage({ name: file.name, size: file.size, type: file.type });
    if (err) { toast.error(err); return; }
    setBusyImage(true);
    try {
      const fd = new FormData();
      fd.append('kind', kind);
      fd.append('file', file);
      const res = await fetch('/api/purchasing/company/image', { method: 'POST', body: fd });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        toast.error(typeof body.error === 'string' ? body.error : 'העלאת התמונה נכשלה');
        return;
      }
      // Re-read the state so the preview uses the proxy URL of the new object.
      const fresh = await fetch('/api/purchasing/company', { credentials: 'include' }).then((r) => r.json());
      setImages({ logo: fresh.logo_url, signature: fresh.signature_url });
      toast.success(kind === 'logo' ? 'הלוגו הועלה' : 'החתימה הועלתה');
    } catch {
      toast.error('העלאת התמונה נכשלה');
    } finally {
      setBusyImage(false);
    }
  }

  async function removeImage(kind: 'logo' | 'signature') {
    setBusyImage(true);
    try {
      const res = await fetch(`/api/purchasing/company/image?kind=${kind}`, { method: 'DELETE' });
      if (!res.ok) { toast.error('ההסרה נכשלה'); return; }
      setImages((i) => ({ ...i, [kind]: null }));
    } catch {
      toast.error('ההסרה נכשלה');
    } finally {
      setBusyImage(false);
    }
  }

  async function save() {
    setTouched(true);
    if (Object.values(errors).some(Boolean) || !form.name.trim() || !form.tax_id.trim() || !form.address.trim()
      || !form.phone.trim() || !/^\S+@\S+\.\S+$/.test(form.email.trim()) || !Number.isFinite(vat) || vat < 0 || vat > 100) return;
    setSaving(true);
    try {
      const res = await fetch('/api/purchasing/company', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: form.name.trim(), tax_id: form.tax_id.trim(), address: form.address.trim(),
          phone: form.phone.trim(), email: form.email.trim(), website: form.website.trim(), vat_rate: vat,
        }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        toast.error(typeof body.error === 'string' ? body.error : 'השמירה נכשלה');
        return;
      }
      const fresh = await fetch('/api/purchasing/company', { credentials: 'include' }).then((r) => r.json());
      toast.success('פרטי החברה נשמרו');
      onSaved({ company: fresh.company, complete: fresh.complete, logo_url: fresh.logo_url, signature_url: fresh.signature_url });
      onOpenChange(false);
    } catch {
      toast.error('השמירה נכשלה');
    } finally {
      setSaving(false);
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
              <SheetTitle className="text-2xl font-bold text-white">
                {wizard ? 'פרטי החברה למסמכי הרכש' : 'הגדרות רכש — נייר מכתבים'}
              </SheetTitle>
              <p className="mt-1 text-sm text-white/70">
                {wizard
                  ? 'לפני המסמך הראשון — הפרטים האלה יופיעו בראש כל בקשה והזמנה. ממלאים פעם אחת.'
                  : 'הפרטים, הלוגו והחתימה שמופיעים על ה-PDF'}
              </p>
            </div>
            <button
              type="button"
              onClick={requestClose}
              aria-label="סגור"
              disabled={saving}
              className="flex h-11 w-11 shrink-0 items-center justify-center rounded-lg border border-white/25 bg-white/5 text-white transition-colors hover:border-white/50 hover:bg-white/15 disabled:opacity-60"
            >
              <X className="h-5 w-5" />
            </button>
          </div>
        </SheetHeader>

        <div className="flex-1 space-y-5 overflow-y-auto bg-slate-50/60 p-5">
          <Section title="פרטי החברה" icon={Building2} iconTone="blue">
            <div className="grid gap-4 py-2 sm:grid-cols-2">
              <div className="sm:col-span-2">
                <Field id="co-name" label="שם החברה" required value={form.name} onChange={(v) => set('name', v)} error={errors.name} disabled={saving} />
              </div>
              <Field id="co-tax" label="ח.פ." required value={form.tax_id} onChange={(v) => set('tax_id', v)} error={errors.tax_id} dir="ltr" inputMode="numeric" tabularNums disabled={saving} />
              <Field id="co-phone" label="טלפון" required value={form.phone} onChange={(v) => set('phone', v)} error={errors.phone} dir="ltr" inputMode="tel" tabularNums disabled={saving} />
              <div className="sm:col-span-2">
                <Field id="co-address" label="כתובת" required value={form.address} onChange={(v) => set('address', v)} error={errors.address} disabled={saving} />
              </div>
              <Field id="co-email" label="מייל" required value={form.email} onChange={(v) => set('email', v)} error={errors.email} dir="ltr" type="email" disabled={saving} />
              <Field id="co-site" label="אתר" value={form.website} onChange={(v) => set('website', v)} dir="ltr" hint="לא חובה" disabled={saving} />
            </div>
          </Section>

          <Section title="שיעור מע״מ" icon={Percent} iconTone="amber">
            <div className="space-y-2 py-2">
              <Field
                id="co-vat" label="שיעור מע״מ (%)" required value={form.vat_rate} onChange={(v) => set('vat_rate', v)}
                error={errors.vat} dir="ltr" inputMode="decimal" tabularNums disabled={saving}
                hint="נשמר על כל מסמך ברגע ההפקה — שינוי כאן לא ישנה מסמכים שכבר הופקו."
              />
            </div>
          </Section>

          <Section title="לוגו וחתימה" icon={ImagePlus} iconTone="violet">
            <div className="space-y-4 py-2">
              <ImagePicker
                id="co-logo" label="לוגו" hint="PNG או JPG, עד 2MB. מופיע בפינה השמאלית העליונה."
                url={images.logo} busy={busyImage} onPick={(f) => pickImage('logo', f)} onRemove={() => removeImage('logo')}
              />
              <ImagePicker
                id="co-signature" label="חתימה סרוקה" hint="PNG או JPG, עד 2MB. רצוי רקע לבן או שקוף."
                url={images.signature} busy={busyImage} onPick={(f) => pickImage('signature', f)} onRemove={() => removeImage('signature')}
              />
            </div>
          </Section>
        </div>

        <PanelFooter
          onClose={requestClose}
          onSave={save}
          saveDisabled={saving || busyImage}
          saveLabel={saving ? 'שומר…' : wizard ? 'שמור והמשך' : 'שמור שינויים'}
          saveIcon={Save}
        />
      </SheetContent>
    </Sheet>
  );
}
