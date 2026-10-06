'use client';

import { useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import { FileText, Gavel, Save, UploadCloud, X } from 'lucide-react';
import { Sheet, SheetContent, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import { Section } from '@/components/side-panel/Section';
import { Field } from '@/components/side-panel/Field';
import { PanelFooter } from '@/components/side-panel/PanelFooter';
import { useEscapeKey } from '@/lib/hooks/useEscapeKey';
import { cn } from '@/lib/utils';
import {
  DECISION_FILE, DECISION_SUMMARY_MAX, DECISION_TITLE_MAX, DECISION_TYPE_LABEL,
  DECISION_TYPES, formatFileSize, validateDecisionFile, type DecisionType,
} from '@/lib/decisions';
import type { DecisionAdminView } from '@/lib/decisionsView';

// The CREATE / EDIT panel of /decisions — a Sheet, per DESIGN §12 ("any create
// or edit opens in a side panel, even a short form").
//
// One panel, two modes, and the difference is the FILE:
//   • create — a PDF is required; the row and the object are written by one
//     request (POST /api/decisions, multipart);
//   • edit   — metadata only. The file is never replaced; replacing a document
//     means deleting it and uploading again (the product rule), so the panel
//     shows the current file as a read-only row instead of a dropzone.
//
// "מספר החלטה" exists only while the type is "החלטה": a protocol is never
// numbered, and the server drops the number if one is sent anyway.

export interface DecisionPanelProps {
  open: boolean;
  /** null = create. */
  decision: DecisionAdminView | null;
  onOpenChange: (o: boolean) => void;
  onSaved: () => void;
}

const today = () => new Date().toLocaleDateString('sv-SE');

interface FormState {
  title: string;
  docType: DecisionType;
  decisionNumber: string;
  decidedAt: string;
  summary: string;
}

const EMPTY: FormState = { title: '', docType: 'decision', decisionNumber: '', decidedAt: '', summary: '' };

export function DecisionPanel({ open, decision, onOpenChange, onSaved }: DecisionPanelProps) {
  const editing = decision !== null;
  const [form, setForm] = useState<FormState>(EMPTY);
  const [file, setFile] = useState<File | null>(null);
  const [fileError, setFileError] = useState<string | null>(null);
  const [touched, setTouched] = useState(false);
  const [saving, setSaving] = useState(false);
  const [dragging, setDragging] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Seed on open — an edit from its row, a create from the defaults ("תאריך
  // החלטה" = today, per the spec).
  useEffect(() => {
    if (!open) return;
    setForm(decision
      ? {
          title: decision.title,
          docType: decision.doc_type,
          decisionNumber: decision.decision_number ?? '',
          decidedAt: decision.decided_at.slice(0, 10),
          summary: decision.summary ?? '',
        }
      : { ...EMPTY, decidedAt: today() });
    setFile(null);
    setFileError(null);
    setTouched(false);
    setDragging(false);
  }, [open, decision]);

  const set = <K extends keyof FormState>(k: K, v: FormState[K]) => setForm((f) => ({ ...f, [k]: v }));

  const titleError = touched && !form.title.trim() ? 'יש להזין כותרת' : null;
  const dateError = touched && !form.decidedAt ? 'יש לבחור תאריך החלטה' : null;
  const missingFile = touched && !editing && !file ? 'יש לצרף קובץ PDF' : null;

  function pickFile(f: File) {
    const err = validateDecisionFile({ name: f.name, size: f.size, type: f.type });
    setFileError(err);
    setFile(err ? null : f);
  }

  useEscapeKey(open, () => requestClose());

  function requestClose() {
    if (saving) return;
    onOpenChange(false);
  }

  async function save() {
    setTouched(true);
    if (!form.title.trim() || !form.decidedAt || (!editing && !file) || fileError || saving) return;
    setSaving(true);
    try {
      const res = editing
        ? await fetch(`/api/decisions/${decision.id}`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              title: form.title.trim(),
              summary: form.summary.trim() || null,
              doc_type: form.docType,
              decision_number: form.docType === 'decision' ? form.decisionNumber.trim() || null : null,
              decided_at: form.decidedAt,
              published: decision.published,
            }),
          })
        : await (() => {
            const fd = new FormData();
            fd.append('file', file as File);
            fd.append('title', form.title.trim());
            fd.append('doc_type', form.docType);
            fd.append('decided_at', form.decidedAt);
            if (form.summary.trim()) fd.append('summary', form.summary.trim());
            if (form.docType === 'decision' && form.decisionNumber.trim()) {
              fd.append('decision_number', form.decisionNumber.trim());
            }
            return fetch('/api/decisions', { method: 'POST', body: fd });
          })();

      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        toast.error(typeof body.error === 'string' ? body.error : 'השמירה נכשלה');
        return;
      }
      toast.success(editing ? 'המסמך עודכן' : 'המסמך הועלה');
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
        side="left"
        dir="rtl"
        showCloseButton={false}
        className="w-full max-w-full p-0 sm:w-[92vw] md:w-[80vw] lg:w-[55vw] lg:min-w-[720px] flex flex-col gap-0 overflow-hidden bg-white"
      >
        <SheetHeader className="flex-none gap-2 bg-gradient-to-bl from-slate-900 via-blue-950 to-blue-900 px-6 py-6 text-white">
          <div className="flex items-start justify-between gap-4">
            <div className="min-w-0 flex-1">
              <SheetTitle className="text-2xl font-bold text-white">
                {editing ? 'עריכת מסמך' : 'העלאת מסמך'}
              </SheetTitle>
              <p className="mt-1 truncate text-sm text-white/70">
                {editing ? decision.title : 'החלטה או פרוטוקול שיוצגו בפורטל הדיירים'}
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
          <Section title="הקובץ" icon={FileText} iconTone="rose">
            <div className="py-2">
              {editing ? (
                <div className="space-y-2">
                  <div className="flex items-center gap-3 rounded-lg border border-line bg-white p-3">
                    <span className="grid h-9 w-9 shrink-0 place-items-center rounded-lg bg-rose-100 text-rose-600">
                      <FileText className="h-4 w-4" />
                    </span>
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-semibold text-ink">{decision.original_filename}</p>
                      <p className="font-num text-xs tabular-nums text-ink-3">
                        PDF · {formatFileSize(decision.file_size)}
                      </p>
                    </div>
                  </div>
                  <p className="text-[12px] text-slate-500">
                    להחלפת הקובץ יש למחוק את המסמך ולהעלות אותו מחדש.
                  </p>
                </div>
              ) : (
                <div className="space-y-2">
                  <button
                    type="button"
                    onClick={() => fileInputRef.current?.click()}
                    onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
                    onDragLeave={() => setDragging(false)}
                    onDrop={(e) => {
                      e.preventDefault();
                      setDragging(false);
                      const f = e.dataTransfer.files[0];
                      if (f) pickFile(f);
                    }}
                    className={cn(
                      'flex w-full flex-col items-center justify-center gap-2 rounded-xl border-2 border-dashed px-6 py-8 text-center transition-colors',
                      dragging ? 'border-brand bg-brand-soft/60' : 'border-line-strong bg-surface-2 hover:border-brand hover:bg-brand-soft/40',
                      (fileError || missingFile) && 'border-red-400 bg-red-50',
                    )}
                  >
                    <span className="grid h-12 w-12 place-items-center rounded-full bg-brand-soft text-brand">
                      <UploadCloud className="h-5 w-5" />
                    </span>
                    <span className="text-sm font-semibold text-ink">גרור קובץ או לחץ לבחירה</span>
                    <span className="text-xs text-ink-3">PDF בלבד · עד 50MB</span>
                  </button>
                  <input
                    ref={fileInputRef}
                    type="file"
                    accept={DECISION_FILE.accept}
                    hidden
                    onChange={(e) => {
                      const f = e.target.files?.[0];
                      if (f) pickFile(f);
                      e.target.value = '';
                    }}
                  />
                  {file && !fileError && (
                    <div className="flex items-center gap-3 rounded-lg border border-line bg-white p-3">
                      <span className="grid h-9 w-9 shrink-0 place-items-center rounded-lg bg-rose-100 text-rose-600">
                        <FileText className="h-4 w-4" />
                      </span>
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-sm font-semibold text-ink">{file.name}</p>
                        <p className="font-num text-xs tabular-nums text-ink-3">PDF · {formatFileSize(file.size)}</p>
                      </div>
                      <button
                        type="button"
                        onClick={() => { setFile(null); setFileError(null); }}
                        aria-label="הסר קובץ"
                        className="shrink-0 rounded-lg p-1 text-ink-3 transition-colors hover:bg-slate-100 hover:text-ink"
                      >
                        <X className="h-4 w-4" />
                      </button>
                    </div>
                  )}
                  {(fileError || missingFile) && (
                    <p className="text-[12px] font-semibold text-red-500 text-start">⚠️ {fileError ?? missingFile}</p>
                  )}
                </div>
              )}
            </div>
          </Section>

          <Section title="פרטי המסמך" icon={Gavel} iconTone="blue">
            <div className="space-y-4 py-2">
              <Field
                id="decision-title"
                label="כותרת"
                required
                value={form.title}
                onChange={(v) => set('title', v.slice(0, DECISION_TITLE_MAX))}
                onBlur={() => setTouched(true)}
                error={titleError}
                placeholder="למשל: שיפוץ לובי וחידוש תאורה"
                disabled={saving}
              />

              <div className="grid gap-4 sm:grid-cols-2">
                <div className="space-y-2">
                  <Label htmlFor="decision-type" className="text-base font-medium text-muted-foreground">
                    סוג מסמך<span className="text-red-500"> *</span>
                  </Label>
                  <Select
                    value={form.docType}
                    onValueChange={(v) => { if (v) set('docType', v as DecisionType); }}
                    disabled={saving}
                  >
                    <SelectTrigger id="decision-type" className="w-full data-[size=default]:h-10">
                      <SelectValue>
                        {(v: string | null) => (v ? DECISION_TYPE_LABEL[v as DecisionType] : null)}
                      </SelectValue>
                    </SelectTrigger>
                    <SelectContent>
                      {DECISION_TYPES.map((t) => (
                        <SelectItem key={t} value={t}>{DECISION_TYPE_LABEL[t]}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>

                <div className="space-y-2">
                  <Label htmlFor="decision-date" className="text-base font-medium text-muted-foreground">
                    תאריך החלטה<span className="text-red-500"> *</span>
                  </Label>
                  <input
                    id="decision-date"
                    type="date"
                    value={form.decidedAt}
                    onChange={(e) => set('decidedAt', e.target.value)}
                    onBlur={() => setTouched(true)}
                    onClick={(e) => {
                      const el = e.currentTarget as HTMLInputElement & { showPicker?: () => void };
                      try { el.showPicker?.(); } catch { /* fallback to the native icon */ }
                    }}
                    disabled={saving}
                    aria-invalid={dateError ? true : undefined}
                    className={cn(
                      'flex h-10 w-full cursor-pointer rounded-md border border-input bg-transparent px-3 py-2 text-base shadow-xs outline-none transition-[color,box-shadow] focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-50 md:text-sm',
                      dateError && 'border-red-400 bg-red-50 focus-visible:ring-red-200',
                    )}
                  />
                  {dateError && <p className="text-[12px] font-semibold text-red-500 text-start">⚠️ {dateError}</p>}
                </div>
              </div>

              {/* Only a decision carries a number — a protocol never shows one. */}
              {form.docType === 'decision' && (
                <Field
                  id="decision-number"
                  label="מספר החלטה"
                  value={form.decisionNumber}
                  onChange={(v) => set('decisionNumber', v)}
                  placeholder="למשל: 14/2026"
                  hint="אופציונלי — יוצג לצד התגית בפורטל."
                  disabled={saving}
                />
              )}

              <div className="space-y-2">
                <Label htmlFor="decision-summary" className="text-base font-medium text-muted-foreground">
                  תקציר
                </Label>
                <Textarea
                  id="decision-summary"
                  value={form.summary}
                  onChange={(e) => set('summary', e.target.value.slice(0, DECISION_SUMMARY_MAX))}
                  disabled={saving}
                  rows={5}
                  placeholder="כמה שורות שיסבירו לדייר על מה המסמך, לפני שהוא פותח אותו."
                />
                <p className="text-[12px] text-slate-500">
                  אופציונלי · <span className="font-num tabular-nums">{form.summary.length} / {DECISION_SUMMARY_MAX}</span>
                </p>
              </div>
            </div>
          </Section>
        </div>

        <PanelFooter
          onClose={requestClose}
          onSave={save}
          saveDisabled={saving}
          saveLabel={saving ? 'שומר…' : editing ? 'שמור שינויים' : 'העלה מסמך'}
          saveIcon={editing ? Save : UploadCloud}
        />
      </SheetContent>
    </Sheet>
  );
}
