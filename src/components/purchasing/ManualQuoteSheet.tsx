'use client';

// A quote that arrived OUTSIDE the system (an e-mail, a file): pick the
// supplier, upload the file, key in the total before VAT; per-line prices are
// optional. Saved as the supplier's single quote on the request (a second save
// replaces it). The file can be attached once the quote exists.

import { useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import { FileText, Hash, ListChecks, Paperclip, Save, UploadCloud, X } from 'lucide-react';
import { Sheet, SheetContent, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { Label } from '@/components/ui/label';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Combobox } from '@/components/ui/combobox';
import { Section } from '@/components/side-panel/Section';
import { Field } from '@/components/side-panel/Field';
import { PanelFooter } from '@/components/side-panel/PanelFooter';
import { useEscapeKey } from '@/lib/hooks/useEscapeKey';
import { cn } from '@/lib/utils';
import { formatFileSize } from '@/lib/decisions';
import { PURCHASING_LIMITS, docHeading } from '@/lib/purchasing/model';
import { PURCHASING_FILE_ACCEPT, validatePurchasingFile } from '@/lib/purchasing/files';
import { parseNumber } from './lines';
import type { DocumentDetail, SupplierBrief } from './types';

interface Props {
  open: boolean;
  detail: DocumentDetail;
  suppliers: SupplierBrief[];
  /** Pre-selected supplier (editing an existing quote). */
  supplierId: string | null;
  onOpenChange: (o: boolean) => void;
  onSaved: () => void;
}

export function ManualQuoteSheet({ open, detail, suppliers, supplierId: initialSupplier, onOpenChange, onSaved }: Props) {
  const doc = detail.document;
  const [supplierId, setSupplierId] = useState<string | null>(null);
  const [total, setTotal] = useState('');
  const [validUntil, setValidUntil] = useState('');
  const [notes, setNotes] = useState('');
  const [prices, setPrices] = useState<Record<string, string>>({});
  const [file, setFile] = useState<File | null>(null);
  const [touched, setTouched] = useState(false);
  const [saving, setSaving] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!open) return;
    setTouched(false);
    setFile(null);
    setSupplierId(initialSupplier);
    const q = initialSupplier ? detail.quotes?.find((x) => x.supplier_id === initialSupplier) : undefined;
    setTotal(q?.total_amount != null ? String(q.total_amount) : '');
    setValidUntil(q?.valid_until ?? '');
    setNotes(q?.notes ?? '');
    setPrices(Object.fromEntries(Object.entries(q?.prices ?? {}).map(([k, v]) => [k, String(v)])));
  }, [open, initialSupplier, detail]);

  const priced = Object.entries(prices).filter(([, v]) => v.trim() !== '');
  const totalNum = parseNumber(total);
  const noAmount = totalNum === null && priced.length === 0;
  const errors = {
    supplier: touched && !supplierId ? 'יש לבחור ספק' : null,
    amount: touched && noAmount ? 'יש להזין סכום כולל או מחירים לפי שורות' : null,
  };

  useEscapeKey(open, () => requestClose());
  function requestClose() { if (!saving) onOpenChange(false); }

  function pickFile(f: File | undefined) {
    if (!f) return;
    const err = validatePurchasingFile({ name: f.name, size: f.size, type: f.type }, PURCHASING_LIMITS.staffFileBytes);
    if (err) { toast.error(err); return; }
    setFile(f);
  }

  async function save() {
    setTouched(true);
    if (!supplierId || noAmount) return;
    const priceMap: Record<string, number> = {};
    for (const [lineId, raw] of priced) {
      const n = parseNumber(raw);
      if (n === null || n < 0) { toast.error('מחיר לא תקין באחת השורות'); return; }
      priceMap[lineId] = n;
    }
    setSaving(true);
    try {
      const res = await fetch(`/api/purchasing/documents/${doc.id}/quotes`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          supplier_id: supplierId, total_amount: totalNum, valid_until: validUntil || null,
          notes: notes.trim(), prices: priceMap,
        }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) { toast.error(typeof body.error === 'string' ? body.error : 'השמירה נכשלה'); return; }
      if (file) {
        const fd = new FormData();
        fd.append('file', file);
        const up = await fetch(`/api/purchasing/documents/${doc.id}/quotes/${supplierId}/files`, { method: 'POST', body: fd });
        if (!up.ok) toast.error('ההצעה נשמרה, אך הקובץ לא הועלה');
      }
      toast.success('ההצעה נשמרה');
      onOpenChange(false);
      onSaved();
    } catch {
      toast.error('השמירה נכשלה');
    } finally {
      setSaving(false);
    }
  }

  return (
    <Sheet open={open} onOpenChange={(o) => { if (!o) requestClose(); else onOpenChange(o); }}>
      <SheetContent
        side="left" dir="rtl" showCloseButton={false}
        className="w-full max-w-full p-0 sm:w-[92vw] md:w-[80vw] lg:w-[55vw] lg:min-w-[720px] flex flex-col gap-0 overflow-hidden bg-white"
      >
        <SheetHeader className="flex-none gap-2 bg-gradient-to-bl from-slate-900 via-blue-950 to-blue-900 px-6 py-6 text-white">
          <div className="flex items-start justify-between gap-4">
            <div className="min-w-0 flex-1">
              <SheetTitle className="text-2xl font-bold text-white">הצעה שהתקבלה מחוץ למערכת</SheetTitle>
              <p className="mt-1 truncate text-sm text-white/70">{docHeading('rfq', doc.number)} — {doc.title}</p>
            </div>
            <button
              type="button" onClick={requestClose} aria-label="סגור" disabled={saving}
              className="flex h-11 w-11 shrink-0 items-center justify-center rounded-lg border border-white/25 bg-white/5 text-white transition-colors hover:border-white/50 hover:bg-white/15 disabled:opacity-60"
            >
              <X className="h-5 w-5" />
            </button>
          </div>
        </SheetHeader>

        <div className="flex-1 space-y-5 overflow-y-auto bg-slate-50/60 p-5">
          <Section title="ההצעה" icon={Hash} iconTone="blue">
            <div className="grid gap-4 py-2 sm:grid-cols-2">
              <div className="space-y-2 sm:col-span-2">
                <Label htmlFor="mq-supplier" className="text-base font-medium text-muted-foreground">
                  ספק<span className="text-red-500"> *</span>
                </Label>
                <Combobox
                  id="mq-supplier" value={supplierId} onChange={setSupplierId} disabled={saving || !!initialSupplier}
                  placeholder="בחירת ספק" searchPlaceholder="חיפוש ספק…"
                  options={suppliers.map((s) => ({ value: s.id, label: s.name, keywords: `${s.email} ${s.phone}` }))}
                />
                {errors.supplier && <p className="text-[12px] font-semibold text-red-500 text-start">⚠️ {errors.supplier}</p>}
              </div>
              <Field
                id="mq-total" label="סכום כולל (לפני מע״מ)" value={total} onChange={setTotal} dir="ltr" inputMode="decimal" tabularNums
                error={errors.amount} placeholder="0.00" disabled={saving}
                hint="אפשר להסתפק בסכום, או להזין מחירים לפי שורות למטה."
              />
              <div className="space-y-2">
                <Label htmlFor="mq-valid" className="text-base font-medium text-muted-foreground">תוקף ההצעה</Label>
                <input
                  id="mq-valid" type="date" value={validUntil} onChange={(e) => setValidUntil(e.target.value)}
                  onClick={(e) => {
                    const el = e.currentTarget as HTMLInputElement & { showPicker?: () => void };
                    try { el.showPicker?.(); } catch { /* fallback to the native icon */ }
                  }}
                  disabled={saving}
                  className="flex h-10 w-full cursor-pointer rounded-md border border-input bg-transparent px-3 py-2 text-base shadow-xs outline-none transition-[color,box-shadow] focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:opacity-50 md:text-sm"
                />
              </div>
              <div className="space-y-2 sm:col-span-2">
                <Label htmlFor="mq-notes" className="text-base font-medium text-muted-foreground">הערות</Label>
                <Textarea id="mq-notes" value={notes} rows={3} disabled={saving} onChange={(e) => setNotes(e.target.value.slice(0, PURCHASING_LIMITS.quoteNotesMax))} />
              </div>
            </div>
          </Section>

          <Section title="מחירים לפי שורות (אופציונלי)" icon={ListChecks} iconTone="emerald">
            <div className="space-y-2 py-2">
              {detail.lines.map((l) => (
                <div key={l.id} className="grid items-center gap-3 rounded-lg border border-line bg-white p-3 sm:grid-cols-[minmax(0,1fr)_120px]">
                  <div className="min-w-0">
                    <p className="truncate text-sm font-semibold text-ink">{l.description}</p>
                    <p className="text-xs tabular-nums text-ink-3">כמות: {l.quantity}</p>
                  </div>
                  <Input
                    value={prices[l.id] ?? ''} dir="ltr" inputMode="decimal" placeholder="מחיר ליחידה" disabled={saving}
                    aria-label={`מחיר ליחידה — ${l.description}`}
                    onChange={(e) => setPrices((p) => ({ ...p, [l.id]: e.target.value }))}
                    className={cn('h-10 tabular-nums')}
                  />
                </div>
              ))}
            </div>
          </Section>

          <Section title="קובץ ההצעה" icon={Paperclip} iconTone="violet">
            <div className="space-y-2 py-2">
              {file ? (
                <div className="flex items-center gap-3 rounded-lg border border-line bg-white p-3">
                  <FileText className="h-4 w-4 shrink-0 text-rose-600" aria-hidden />
                  <span className="min-w-0 flex-1 truncate text-sm font-semibold text-ink">{file.name}</span>
                  <span className="text-xs tabular-nums text-ink-3">{formatFileSize(file.size)}</span>
                  <button type="button" onClick={() => setFile(null)} aria-label="הסר קובץ" className="grid h-11 w-11 place-items-center rounded-lg text-ink-3 hover:bg-slate-100">
                    <X className="h-4 w-4" />
                  </button>
                </div>
              ) : (
                <button
                  type="button" onClick={() => fileInput.current?.click()} disabled={saving}
                  className="flex w-full flex-col items-center justify-center gap-1 rounded-xl border-2 border-dashed border-line-strong bg-surface-2 px-6 py-5 text-center transition-colors hover:border-brand hover:bg-brand-soft/40"
                >
                  <UploadCloud className="h-5 w-5 text-brand" aria-hidden />
                  <span className="text-sm font-semibold text-ink">העלאת קובץ ההצעה</span>
                  <span className="text-xs text-ink-3">PDF, תמונות, Word, Excel · עד 20MB</span>
                </button>
              )}
              <input ref={fileInput} type="file" hidden accept={PURCHASING_FILE_ACCEPT} onChange={(e) => { pickFile(e.target.files?.[0]); e.target.value = ''; }} />
            </div>
          </Section>
        </div>

        <PanelFooter onClose={requestClose} onSave={save} saveDisabled={saving} saveLabel={saving ? 'שומר…' : 'שמור הצעה'} saveIcon={Save} />
      </SheetContent>
    </Sheet>
  );
}
