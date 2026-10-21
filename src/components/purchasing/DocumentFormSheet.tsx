'use client';

// CREATE / EDIT of a request for quotation or a purchase order — one Sheet
// (DESIGN §12), the two documents differ only in a few fields:
//   rfq: title · due date · lines (description + quantity) · notes · files
//   po : supplier · subject · lines (+ unit price, totals with VAT) · notes
// The number is allocated by the server on save (atomic, never editable); the
// first document of a series asks "from which number to start". The date is
// today, fixed at issue. The VAT rate shown is the company's current rate — the
// server stamps it on the document at that moment.

import { useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import { FileText, Hash, ListChecks, Paperclip, Save, Send, StickyNote, Trash2, Truck, UploadCloud, X } from 'lucide-react';
import { Sheet, SheetContent, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Combobox } from '@/components/ui/combobox';
import { Section } from '@/components/side-panel/Section';
import { Field } from '@/components/side-panel/Field';
import { PanelFooter } from '@/components/side-panel/PanelFooter';
import { useEscapeKey } from '@/lib/hooks/useEscapeKey';
import { cn } from '@/lib/utils';
import { formatFileSize } from '@/lib/decisions';
import { DOC_LABEL, formatDocDate, PURCHASING_LIMITS, todayIsrael, type DocType } from '@/lib/purchasing/model';
import { PURCHASING_FILE_ACCEPT, PURCHASING_FILE_TYPES_LABEL, validatePurchasingFile } from '@/lib/purchasing/files';
import { LinesEditor } from './LinesEditor';
import { draftsToPayload, emptyLine, newLineKey, type LineDraft } from './lines';
import type { DocumentDetail, PoPrefill, SequenceState, SupplierBrief } from './types';

interface Props {
  open: boolean;
  type: DocType;
  /** null = create. */
  detail: DocumentDetail | null;
  prefill: PoPrefill | null;
  vatRate: number;
  sequences: SequenceState;
  suppliers: SupplierBrief[];
  onOpenChange: (o: boolean) => void;
  /** The company letterhead is missing: ask for it first. */
  onNeedCompany: () => void;
  onSaved: (id: string) => void;
}

const plusDays = (iso: string, days: number) => {
  const d = new Date(`${iso}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
};

export function DocumentFormSheet({
  open, type, detail, prefill, vatRate, sequences, suppliers, onOpenChange, onNeedCompany, onSaved,
}: Props) {
  const editing = detail !== null;
  const isRfq = type === 'rfq';
  const today = todayIsrael();

  const [title, setTitle] = useState('');
  const [dueDate, setDueDate] = useState('');
  const [supplierId, setSupplierId] = useState<string | null>(null);
  const [notes, setNotes] = useState('');
  const [startNumber, setStartNumber] = useState('');
  const [lines, setLines] = useState<LineDraft[]>([emptyLine()]);
  const [staged, setStaged] = useState<File[]>([]);
  const [existing, setExisting] = useState(detail?.files ?? []);
  const [touched, setTouched] = useState(false);
  const [lineError, setLineError] = useState<{ key?: string; message: string } | null>(null);
  const [saving, setSaving] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);

  // Seed on open: an edit from the document, a PO from a winning quote's
  // prefill, otherwise empty defaults (due date two weeks out).
  useEffect(() => {
    if (!open) return;
    setTouched(false);
    setLineError(null);
    setStaged([]);
    setStartNumber('');
    if (detail) {
      setTitle(detail.document.title);
      setDueDate(detail.document.due_date ?? '');
      setSupplierId(detail.document.supplier_id);
      setNotes(detail.document.notes);
      setExisting(detail.files);
      setLines(detail.lines.length
        ? detail.lines.map((l) => ({
            key: newLineKey(), description: l.description, quantity: String(l.quantity),
            unit_price: l.unit_price === null ? '' : String(l.unit_price),
          }))
        : [emptyLine()]);
    } else if (prefill) {
      setTitle(prefill.title);
      setDueDate('');
      setSupplierId(prefill.supplier_id);
      setNotes('');
      setExisting([]);
      setLines(prefill.lines.map((l) => ({
        key: newLineKey(), description: l.description, quantity: String(l.quantity),
        unit_price: l.unit_price === null ? '' : String(l.unit_price),
      })));
    } else {
      setTitle('');
      setDueDate(plusDays(today, 14));
      setSupplierId(null);
      setNotes('');
      setExisting([]);
      setLines([emptyLine()]);
    }
  }, [open, detail, prefill, today]);

  const needsStart = !editing && sequences[type] === null;
  const startValue = Number(startNumber);
  const errors = {
    title: touched && isRfq && !title.trim() ? 'יש להזין כותרת' : null,
    due: touched && isRfq && !dueDate ? 'יש לבחור תאריך יעד' : null,
    supplier: touched && !isRfq && !supplierId ? 'יש לבחור ספק' : null,
    start: touched && needsStart && (!Number.isInteger(startValue) || startValue < 1) ? 'יש להזין מספר שלם מ-1 ומעלה' : null,
  };
  const linesLocked = isRfq && editing && (detail?.recipients?.length ?? 0) > 0;

  useEscapeKey(open, () => requestClose());
  function requestClose() { if (!saving) onOpenChange(false); }

  function stageFiles(list: FileList | null) {
    if (!list) return;
    const next = [...staged];
    for (const f of Array.from(list)) {
      const err = validatePurchasingFile({ name: f.name, size: f.size, type: f.type }, PURCHASING_LIMITS.staffFileBytes);
      if (err) { toast.error(`${f.name}: ${err}`); continue; }
      if (existing.length + next.length >= PURCHASING_LIMITS.staffFilesMax) {
        toast.error(`אפשר לצרף עד ${PURCHASING_LIMITS.staffFilesMax} קבצים`);
        break;
      }
      next.push(f);
    }
    setStaged(next);
  }

  async function uploadStaged(documentId: string): Promise<number> {
    let failed = 0;
    for (const f of staged) {
      const fd = new FormData();
      fd.append('file', f);
      try {
        const res = await fetch(`/api/purchasing/documents/${documentId}/files`, { method: 'POST', body: fd });
        if (!res.ok) failed++;
      } catch { failed++; }
    }
    return failed;
  }

  async function removeExisting(fileId: string) {
    if (!window.confirm('להסיר את הקובץ?')) return;
    try {
      const res = await fetch(`/api/purchasing/files/${fileId}`, { method: 'DELETE' });
      if (!res.ok) throw new Error('delete failed');
      setExisting((e) => e.filter((f) => f.id !== fileId));
    } catch {
      toast.error('ההסרה נכשלה');
    }
  }

  async function save() {
    setTouched(true);
    setLineError(null);
    if (errors.title || errors.due || errors.supplier || errors.start) return;
    if (isRfq && (!title.trim() || !dueDate)) return;
    if (!isRfq && !supplierId) return;
    if (needsStart && (!Number.isInteger(startValue) || startValue < 1)) return;

    const payload = draftsToPayload(lines, !isRfq);
    if (!payload.ok) { setLineError({ key: payload.key, message: payload.error }); return; }

    setSaving(true);
    try {
      let res: Response;
      if (editing && detail) {
        res = await fetch(`/api/purchasing/documents/${detail.document.id}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            title: title.trim(), supplier_id: isRfq ? null : supplierId, notes: notes.trim(),
            due_date: isRfq ? dueDate : null,
            ...(linesLocked ? {} : { lines: payload.lines }),
          }),
        });
      } else {
        res = await fetch('/api/purchasing/documents', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            doc_type: type, doc_date: today, title: title.trim(), notes: notes.trim(),
            start_number: needsStart ? startValue : null, lines: payload.lines,
            ...(isRfq
              ? { due_date: dueDate }
              : { supplier_id: supplierId, source_rfq_id: prefill?.source_rfq_id ?? null }),
          }),
        });
      }
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        if (body.error === 'company_missing') { onNeedCompany(); return; }
        if (body.error === 'start_number_required') { toast.error('יש להזין מספר התחלתי'); return; }
        toast.error(typeof body.error === 'string' ? body.error : 'השמירה נכשלה');
        return;
      }
      const id: string = editing && detail ? detail.document.id : body.id;
      const failedFiles = await uploadStaged(id);
      if (failedFiles) toast.error(`${failedFiles} קבצים לא הועלו — אפשר להוסיף אותם מחדש מהמסמך`);
      toast.success(editing ? 'המסמך עודכן' : `${DOC_LABEL[type]} מספר ${body.number} הופקה`);
      onOpenChange(false);
      onSaved(id);
    } catch {
      toast.error('השמירה נכשלה');
    } finally {
      setSaving(false);
    }
  }

  const heading = editing
    ? `${DOC_LABEL[type]} מספר ${detail?.document.number}`
    : prefill ? 'הזמנת רכש מהצעה זוכה' : `${DOC_LABEL[type]} חדשה`;

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
              <SheetTitle className="text-2xl font-bold text-white">{heading}</SheetTitle>
              <p className="mt-1 truncate text-sm text-white/70">
                {isRfq ? 'שורות ללא מחירים — הספקים ממלאים מחיר ליחידה בקישור האישי שלהם' : 'שורות עם מחירים, סיכומים ומע״מ'}
                {prefill ? ` · מבקשה מספר ${prefill.source_rfq_number}` : ''}
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
          <Section title="פרטי המסמך" icon={Hash} iconTone="blue">
            <div className="grid gap-4 py-2 sm:grid-cols-2">
              {/* Number — never editable; the first of a series asks where to start. */}
              {needsStart ? (
                <Field
                  id="doc-start" label="מאיזה מספר להתחיל" required value={startNumber}
                  onChange={setStartNumber} error={errors.start} dir="ltr" inputMode="numeric" tabularNums disabled={saving}
                  hint={`זה ${DOC_LABEL[type]} הראשונה — משם המספר רץ אוטומטית ואי אפשר לערוך אותו.`}
                />
              ) : (
                <div className="space-y-2">
                  <Label className="text-base font-medium text-muted-foreground">מספר</Label>
                  <div className="flex h-10 items-center rounded-md border border-line bg-slate-100 px-3 text-sm tabular-nums text-ink-2" data-doc-number>
                    {editing ? detail?.document.number : `יוקצה בשמירה (${(sequences[type] ?? 0) + 1})`}
                  </div>
                </div>
              )}
              <div className="space-y-2">
                <Label className="text-base font-medium text-muted-foreground">תאריך</Label>
                <div className="flex h-10 items-center rounded-md border border-line bg-slate-100 px-3 text-sm tabular-nums text-ink-2">
                  {formatDocDate(editing ? detail?.document.doc_date : today)}
                </div>
              </div>

              {isRfq ? (
                <>
                  <div className="sm:col-span-2">
                    <Field id="doc-title" label="כותרת" required value={title} onChange={(v) => setTitle(v.slice(0, PURCHASING_LIMITS.titleMax))}
                      error={errors.title} placeholder="למשל: חידוש צבע בחדרי המדרגות" disabled={saving} />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="doc-due" className="text-base font-medium text-muted-foreground">
                      תאריך יעד להגשה<span className="text-red-500"> *</span>
                    </Label>
                    <input
                      id="doc-due" type="date" value={dueDate} min={editing ? undefined : today}
                      onChange={(e) => setDueDate(e.target.value)}
                      onClick={(e) => {
                        const el = e.currentTarget as HTMLInputElement & { showPicker?: () => void };
                        try { el.showPicker?.(); } catch { /* fallback to the native icon */ }
                      }}
                      disabled={saving}
                      aria-invalid={errors.due ? true : undefined}
                      className={cn(
                        'flex h-10 w-full cursor-pointer rounded-md border border-input bg-transparent px-3 py-2 text-base shadow-xs outline-none transition-[color,box-shadow] focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-50 md:text-sm',
                        errors.due && 'border-red-400 bg-red-50 focus-visible:ring-red-200',
                      )}
                    />
                    {errors.due && <p className="text-[12px] font-semibold text-red-500 text-start">⚠️ {errors.due}</p>}
                    <p className="text-[12px] text-slate-500">עד תאריך זה הספק יכול להגיש ולתקן הצעה; אחריו הקישור נעול לקריאה.</p>
                  </div>
                </>
              ) : (
                <>
                  <div className="space-y-2 sm:col-span-2">
                    <Label htmlFor="doc-supplier" className="text-base font-medium text-muted-foreground">
                      ספק<span className="text-red-500"> *</span>
                    </Label>
                    <Combobox
                      id="doc-supplier" value={supplierId} onChange={setSupplierId} disabled={saving}
                      placeholder="בחירת ספק" searchPlaceholder="חיפוש ספק…"
                      options={suppliers.map((s) => ({ value: s.id, label: s.name, keywords: `${s.email} ${s.phone} ${s.mobile}` }))}
                    />
                    {errors.supplier && <p className="text-[12px] font-semibold text-red-500 text-start">⚠️ {errors.supplier}</p>}
                  </div>
                  <div className="sm:col-span-2">
                    <Field id="doc-title" label="נושא" value={title} onChange={(v) => setTitle(v.slice(0, PURCHASING_LIMITS.titleMax))}
                      placeholder="למשל: חומרי ניקוי לחודש נובמבר" hint="אופציונלי — מופיע מתחת לכותרת ה-PDF." disabled={saving} />
                  </div>
                </>
              )}
            </div>
          </Section>

          <Section title="שורות" icon={ListChecks} iconTone="emerald">
            <div className="space-y-3 py-2">
              {linesLocked && (
                <p className="rounded-md border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">
                  הבקשה כבר נשלחה לספקים — השורות נעולות, כי ההצעות מתומחרות לפיהן.
                </p>
              )}
              <LinesEditor
                lines={lines} onChange={setLines} withPrices={!isRfq} vatRate={vatRate}
                disabled={saving || linesLocked} errorKey={lineError?.key ?? null}
              />
              {lineError && <p className="text-[12px] font-semibold text-red-500 text-start">⚠️ {lineError.message}</p>}
            </div>
          </Section>

          <Section title="הערות" icon={StickyNote} iconTone="amber">
            <div className="space-y-2 py-2">
              <Textarea
                id="doc-notes" value={notes} rows={4} disabled={saving}
                onChange={(e) => setNotes(e.target.value.slice(0, PURCHASING_LIMITS.notesMax))}
                placeholder="תנאי אספקה, הבהרות לספק…"
              />
              <p className="text-[12px] text-slate-500">מופיע ב-PDF. אופציונלי.</p>
            </div>
          </Section>

          {isRfq && (
            <Section title="קבצים מצורפים" icon={Paperclip} iconTone="violet">
              <div className="space-y-3 py-2">
                {existing.map((f) => (
                  <div key={f.id} className="flex items-center gap-3 rounded-lg border border-line bg-white p-3">
                    <FileText className="h-4 w-4 shrink-0 text-rose-600" aria-hidden />
                    <a href={f.url} target="_blank" rel="noopener noreferrer" className="min-w-0 flex-1 truncate text-sm font-semibold text-ink hover:underline">
                      {f.original_filename}
                    </a>
                    <span className="text-xs tabular-nums text-ink-3">{formatFileSize(f.file_size)}</span>
                    <button type="button" onClick={() => removeExisting(f.id)} aria-label={`הסרת ${f.original_filename}`}
                      className="grid h-11 w-11 place-items-center rounded-lg text-ink-3 hover:bg-rose-50 hover:text-rose-600">
                      <Trash2 className="h-4 w-4" />
                    </button>
                  </div>
                ))}
                {staged.map((f, i) => (
                  <div key={`${f.name}-${i}`} className="flex items-center gap-3 rounded-lg border border-dashed border-line-strong bg-white p-3">
                    <FileText className="h-4 w-4 shrink-0 text-ink-3" aria-hidden />
                    <span className="min-w-0 flex-1 truncate text-sm text-ink">{f.name}</span>
                    <span className="text-xs tabular-nums text-ink-3">{formatFileSize(f.size)}</span>
                    <button type="button" onClick={() => setStaged((s) => s.filter((_, j) => j !== i))} aria-label={`הסרת ${f.name}`}
                      className="grid h-11 w-11 place-items-center rounded-lg text-ink-3 hover:bg-slate-100">
                      <X className="h-4 w-4" />
                    </button>
                  </div>
                ))}
                <button
                  type="button" onClick={() => fileInput.current?.click()} disabled={saving}
                  className="flex w-full flex-col items-center justify-center gap-1 rounded-xl border-2 border-dashed border-line-strong bg-surface-2 px-6 py-5 text-center transition-colors hover:border-brand hover:bg-brand-soft/40"
                >
                  <UploadCloud className="h-5 w-5 text-brand" aria-hidden />
                  <span className="text-sm font-semibold text-ink">הוספת קובץ</span>
                  <span className="text-xs text-ink-3">{PURCHASING_FILE_TYPES_LABEL} · עד {PURCHASING_LIMITS.staffFilesMax} קבצים, 20MB לקובץ</span>
                </button>
                <input
                  ref={fileInput} type="file" multiple hidden accept={PURCHASING_FILE_ACCEPT}
                  onChange={(e) => { stageFiles(e.target.files); e.target.value = ''; }}
                />
                <p className="text-[12px] text-slate-500">הספקים רואים וקוראים את הקבצים האלה בקישור האישי שלהם.</p>
              </div>
            </Section>
          )}

          {!isRfq && <div className="flex items-center gap-2 text-xs text-ink-3"><Truck className="h-3.5 w-3.5" aria-hidden />ה-PDF והשליחה לספק זמינים מיד אחרי ההפקה.</div>}
        </div>

        <PanelFooter
          onClose={requestClose}
          onSave={save}
          saveDisabled={saving}
          saveLabel={saving ? 'שומר…' : editing ? 'שמור שינויים' : 'הפק מסמך'}
          saveIcon={editing ? Save : Send}
        />
      </SheetContent>
    </Sheet>
  );
}
