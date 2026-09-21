'use client';

import { useEffect, useMemo, useState } from 'react';
import { AlertTriangle, Coins, FileText, Paperclip, Receipt, Trash2, X } from 'lucide-react';
import { toast } from 'sonner';
import { Sheet, SheetContent, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Section } from '@/components/side-panel/Section';
import { PanelFooter } from '@/components/side-panel/PanelFooter';
import { Field } from '@/components/side-panel/Field';
import {
  AttachmentPicker, isUploading, readyAttachmentIds, type AttachmentPolicy, type StagedAttachment,
} from '@/components/whatsapp/AttachmentPicker';
import { fileMeta, formatBytes } from '@/components/documents/helpers';
import { useEscapeKey } from '@/lib/hooks/useEscapeKey';
import { cn } from '@/lib/utils';
import { todayInJerusalem } from '@/lib/dates';
import {
  FINANCE_RECEIPT_ACCEPT, FINANCE_RECEIPT_LIMITS, FIN_KIND_LABEL,
  receiptCanonicalMime, receiptExt, receiptHelpText, validateFinanceReceipt, validateFinanceReceiptSet,
  type FinKind,
} from '@/lib/constants/finance';
import { amountToInput, ils } from '@/lib/finance/format';
import { monthLabel, shiftMonthKey } from '@/lib/finance/period';
import type { DuplicateExpense, FinCategory, FinDocumentView, FinEntry, SupplierOption } from '@/lib/types/finance';
import { DriveStatusIcon } from './DriveStatusIcon';
import { SupplierSearchField } from './SupplierSearchField';

// The one CREATE / EDIT sheet of the finance module — an expense or an income
// (`kind`). Same skeleton as issues/issue-form-panel.tsx: gradient header,
// Sections, PanelFooter, dirty-close guard. Receipts are STAGED through the
// shared AttachmentPicker (POST /api/finance/documents) and linked on save.
// Mount with a fresh `key` per open so the form starts from `entry`.

const RECEIPT_POLICY: AttachmentPolicy = {
  accept: FINANCE_RECEIPT_ACCEPT,
  helpText: receiptHelpText,
  validateFile: validateFinanceReceipt,
  validateSet: validateFinanceReceiptSet,
  mimeOf: (f) => receiptCanonicalMime(receiptExt(f.name)) ?? f.type,
};

interface FormState {
  category_id: string;
  amount: string;
  payment_date: string;
  month: string;
  supplier_id: string | null;
  supplier_name: string;
  invoice_number: string;
  description: string;
  internal_note: string;
}

function initialForm(kind: FinKind, entry: FinEntry | null, defaultMonth: string, keep?: Pick<FormState, 'payment_date' | 'month'>): FormState {
  return {
    category_id: entry?.category_id ?? '',
    amount: entry ? amountToInput(entry.amount) : '',
    payment_date: entry?.payment_date ?? keep?.payment_date ?? todayInJerusalem(),
    month: entry ? entry.period_month.slice(0, 7) : keep?.month ?? defaultMonth,
    supplier_id: entry?.supplier_id ?? null,
    supplier_name: entry?.supplier_name ?? '',
    invoice_number: entry?.invoice_number ?? '',
    description: entry?.description ?? '',
    internal_note: entry?.internal_note ?? '',
  };
}

/** 'YYYY-MM-DD' → 'DD/MM/YYYY'. */
const fmtDate = (iso: string | null) => (iso ? iso.split('-').reverse().join('/') : '—');

export function EntrySheet({
  open, kind, entry, defaultMonth, categories, suppliers, canEdit, onOpenChange, onSaved, onDelete,
}: {
  open: boolean;
  kind: FinKind;
  entry: FinEntry | null;
  /** The month the overview shows — the default for a new income. */
  defaultMonth: string;
  categories: FinCategory[];
  suppliers: SupplierOption[];
  canEdit: boolean;
  onOpenChange: (o: boolean) => void;
  onSaved: (entry: FinEntry) => void;
  onDelete?: () => void;
}) {
  const isEdit = entry !== null;
  const isExpense = kind === 'expense';
  const initial = useMemo(() => initialForm(kind, entry, defaultMonth), [kind, entry, defaultMonth]);
  const [form, setForm] = useState<FormState>(initial);
  const [touched, setTouched] = useState<Partial<Record<keyof FormState, boolean>>>({});
  const [staged, setStaged] = useState<StagedAttachment[]>([]);
  const [existingDocs, setExistingDocs] = useState<FinDocumentView[]>(entry?.documents ?? []);
  const [docToRemove, setDocToRemove] = useState<FinDocumentView | null>(null);
  const [duplicate, setDuplicate] = useState<DuplicateExpense | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [confirmClose, setConfirmClose] = useState(false);

  const set = <K extends keyof FormState>(k: K, v: FormState[K]) => setForm((f) => ({ ...f, [k]: v }));
  const touch = (k: keyof FormState) => setTouched((t) => ({ ...t, [k]: true }));

  // Active categories of this kind (+ the entry's own one even if it was
  // deactivated since — the line keeps its category).
  const categoryOptions = useMemo(
    () => categories.filter((c) => c.kind === kind && (c.is_active || c.id === entry?.category_id)),
    [categories, kind, entry?.category_id],
  );
  const monthOptions = useMemo(() => {
    const set = new Set<string>();
    for (let i = -18; i <= 3; i++) set.add(shiftMonthKey(defaultMonth, i));
    if (form.month) set.add(form.month);
    return [...set].sort().reverse();
  }, [defaultMonth, form.month]);

  const amountNum = Number(form.amount.replace(/,/g, '').trim());
  const errors: Partial<Record<keyof FormState, string>> = {
    category_id: !form.category_id ? 'סעיף הוא שדה חובה' : undefined,
    amount: !form.amount.trim()
      ? 'סכום הוא שדה חובה'
      : !Number.isFinite(amountNum) || amountNum <= 0 ? 'הסכום חייב להיות מספר גדול מ-0' : undefined,
    payment_date: isExpense && !form.payment_date ? 'תאריך תשלום הוא שדה חובה' : undefined,
    month: !isExpense && !form.month ? 'חודש הוא שדה חובה' : undefined,
  };
  const err = (k: keyof FormState) => (touched[k] ? errors[k] ?? null : null);
  const hasErrors = Object.values(errors).some(Boolean);
  const uploading = isUploading(staged);
  const dirty = JSON.stringify(form) !== JSON.stringify(initial) || staged.length > 0;
  const canSubmit = canEdit && !hasErrors && !submitting && !uploading;
  const remainingFiles = Math.max(0, FINANCE_RECEIPT_LIMITS.maxFiles - existingDocs.length);

  // Duplicate warning (expense): same supplier + same invoice number, debounced.
  useEffect(() => {
    if (!isExpense) return;
    const invoice = form.invoice_number.trim();
    const shouldCheck = !!invoice && (!!form.supplier_id || !!form.supplier_name.trim());
    const t = window.setTimeout(async () => {
      if (!shouldCheck) { setDuplicate(null); return; }
      const q = new URLSearchParams({ invoice, supplier_name: form.supplier_name.trim() });
      if (form.supplier_id) q.set('supplier_id', form.supplier_id);
      if (entry?.id) q.set('exclude', entry.id);
      try {
        const r = await fetch(`/api/finance/entries/duplicate-check?${q.toString()}`, { credentials: 'include' });
        const data = (await r.json().catch(() => ({}))) as { duplicate?: DuplicateExpense | null };
        setDuplicate(r.ok ? data.duplicate ?? null : null);
      } catch {
        setDuplicate(null);
      }
    }, 400);
    return () => window.clearTimeout(t);
  }, [isExpense, form.invoice_number, form.supplier_id, form.supplier_name, entry?.id]);

  useEscapeKey(open && !confirmClose && !docToRemove, () => requestClose());
  useEscapeKey(confirmClose, () => setConfirmClose(false));

  function requestClose() {
    if (submitting || uploading) return;
    if (dirty) setConfirmClose(true);
    else onOpenChange(false);
  }
  function discardStaged() {
    // Best-effort: staged uploads that were never saved are removed now rather
    // than waiting for the Storage GC's 24h window.
    for (const s of staged) {
      if (s.attachmentId) {
        void fetch(`/api/finance/documents/${s.attachmentId}`, { method: 'DELETE', credentials: 'include', keepalive: true }).catch(() => undefined);
      }
    }
  }
  function confirmDiscardClose() {
    setConfirmClose(false);
    discardStaged();
    onOpenChange(false);
  }

  async function save(again: boolean) {
    setTouched({ category_id: true, amount: true, payment_date: true, month: true });
    if (!canSubmit) return;
    setSubmitting(true);
    try {
      const base = {
        category_id: form.category_id,
        amount: Math.round(amountNum * 100) / 100,
        description: form.description.trim(),
        internal_note: form.internal_note.trim(),
        document_ids: readyAttachmentIds(staged),
      };
      const body = isExpense
        ? { kind, ...base, payment_date: form.payment_date, supplier_id: form.supplier_id, supplier_name: form.supplier_name.trim(), invoice_number: form.invoice_number.trim() }
        : { kind, ...base, month: form.month };
      const r = await fetch(isEdit ? `/api/finance/entries/${entry.id}` : '/api/finance/entries', {
        method: isEdit ? 'PATCH' : 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify(body),
      });
      const data = (await r.json().catch(() => ({}))) as {
        entry?: FinEntry; error?: string; documents_linked?: number; documents_requested?: number;
      };
      if (!r.ok || !data.entry) throw new Error(data.error ?? 'שמירה נכשלה');
      if ((data.documents_linked ?? 0) < (data.documents_requested ?? 0)) {
        toast.warning('חלק מהקבצים לא צורפו — פתח את השורה וצרף אותם שוב');
      }
      toast.success(isEdit ? 'השורה עודכנה' : `${FIN_KIND_LABEL[kind]} נשמרה`);
      onSaved(data.entry);
      if (again) {
        setForm(initialForm(kind, null, defaultMonth, { payment_date: form.payment_date, month: form.month }));
        setStaged([]);
        setTouched({});
        setDuplicate(null);
      } else {
        onOpenChange(false);
      }
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setSubmitting(false);
    }
  }

  async function removeExistingDoc(doc: FinDocumentView) {
    setDocToRemove(null);
    try {
      const r = await fetch(`/api/finance/documents/${doc.id}`, { method: 'DELETE', credentials: 'include' });
      const data = (await r.json().catch(() => ({}))) as { error?: string };
      if (!r.ok) throw new Error(data.error ?? 'הסרת הקובץ נכשלה');
      setExistingDocs((d) => d.filter((x) => x.id !== doc.id));
      toast.success('הקובץ הוסר');
    } catch (e) {
      toast.error((e as Error).message);
    }
  }

  const disabled = !canEdit || submitting;
  const title = isEdit ? `עריכת ${FIN_KIND_LABEL[kind]}` : `${FIN_KIND_LABEL[kind]} חדשה`;
  const selectedCategory = categoryOptions.find((c) => c.id === form.category_id);

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
                <SheetTitle className="text-2xl font-bold text-white">{title}</SheetTitle>
                <p className="mt-1 text-sm text-white/70">
                  {isExpense
                    ? 'ההוצאה נספרת במלואה בחודש של תאריך התשלום.'
                    : 'ההכנסה נרשמת לחודש שנבחר.'}
                  {!canEdit && ' תצוגה בלבד — אין לך הרשאת עריכה.'}
                </p>
              </div>
              <button
                type="button"
                onClick={requestClose}
                aria-label="סגור"
                disabled={submitting || uploading}
                className="flex h-11 w-11 shrink-0 items-center justify-center rounded-lg border border-white/25 bg-white/5 text-white transition-colors hover:border-white/50 hover:bg-white/15 disabled:opacity-60"
              >
                <X className="h-5 w-5" />
              </button>
            </div>
          </SheetHeader>

          <div className="flex-1 overflow-y-auto bg-slate-50/60 p-5">
            <div className="space-y-4">
              <Section
                title={isExpense ? 'פרטי ההוצאה' : 'פרטי ההכנסה'}
                icon={isExpense ? Receipt : Coins}
                iconTone={isExpense ? 'rose' : 'emerald'}
              >
                <div className="space-y-4 py-2">
                  {isExpense && (
                    <SupplierSearchField
                      suppliers={suppliers}
                      value={{ supplier_id: form.supplier_id, supplier_name: form.supplier_name }}
                      onChange={(v) => setForm((f) => ({ ...f, ...v }))}
                      disabled={disabled}
                    />
                  )}

                  <div className="grid gap-4 sm:grid-cols-2">
                    <div className="space-y-2">
                      <Label htmlFor="fin-entry-category" className="text-base font-medium text-muted-foreground">
                        סעיף<span className="text-red-500"> *</span>
                      </Label>
                      <Select
                        value={form.category_id || null}
                        onValueChange={(v) => { if (v) { set('category_id', v); touch('category_id'); } }}
                        disabled={disabled}
                      >
                        <SelectTrigger
                          id="fin-entry-category"
                          aria-invalid={err('category_id') ? true : undefined}
                          className={cn('w-full data-[size=default]:h-10', err('category_id') && 'border-red-400 bg-red-50')}
                        >
                          <SelectValue placeholder={categoryOptions.length ? 'בחר סעיף' : 'אין סעיפים פעילים — הוסף בהגדרות'}>
                            {(v: string | null) => (v ? categoryOptions.find((c) => c.id === v)?.name ?? null : null)}
                          </SelectValue>
                        </SelectTrigger>
                        <SelectContent>
                          {categoryOptions.map((c) => (
                            <SelectItem key={c.id} value={c.id}>
                              {c.name}{c.section === 'renovation_fund' ? ' · קרן שיפוצים' : ''}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                      {err('category_id')
                        ? <p className="text-[12px] font-semibold text-red-500 text-start">⚠️ {err('category_id')}</p>
                        : selectedCategory?.section === 'renovation_fund'
                          ? <p className="text-[12px] text-slate-500 text-start">סעיף בקרן השיפוצים — מוצג בנפרד מהתקציב השוטף.</p>
                          : null}
                    </div>

                    <Field
                      id="fin-entry-amount"
                      label="סכום (₪)"
                      value={form.amount}
                      onChange={(v) => set('amount', v)}
                      onBlur={() => touch('amount')}
                      error={err('amount')}
                      required
                      disabled={disabled}
                      dir="ltr"
                      inputMode="decimal"
                      tabularNums
                      placeholder="0.00"
                    />

                    {isExpense ? (
                      <div className="space-y-2">
                        <Label htmlFor="fin-entry-date" className="text-base font-medium text-muted-foreground">
                          תאריך תשלום<span className="text-red-500"> *</span>
                        </Label>
                        <Input
                          id="fin-entry-date"
                          type="date"
                          value={form.payment_date}
                          onChange={(e) => set('payment_date', e.target.value)}
                          onBlur={() => touch('payment_date')}
                          disabled={disabled}
                          onClick={(e) => {
                            const el = e.currentTarget as HTMLInputElement & { showPicker?: () => void };
                            try { el.showPicker?.(); } catch { /* native fallback */ }
                          }}
                          aria-invalid={err('payment_date') ? true : undefined}
                          className={cn('h-10 cursor-pointer', err('payment_date') && 'border-red-400 bg-red-50 focus-visible:ring-red-200')}
                        />
                        {err('payment_date')
                          ? <p className="text-[12px] font-semibold text-red-500 text-start">⚠️ {err('payment_date')}</p>
                          : form.payment_date
                            ? <p className="text-[12px] text-slate-500 text-start">תיספר בחודש {monthLabel(form.payment_date.slice(0, 7))}</p>
                            : null}
                      </div>
                    ) : (
                      <div className="space-y-2">
                        <Label htmlFor="fin-entry-month" className="text-base font-medium text-muted-foreground">
                          חודש<span className="text-red-500"> *</span>
                        </Label>
                        <Select value={form.month || null} onValueChange={(v) => { if (v) set('month', v); }} disabled={disabled}>
                          <SelectTrigger id="fin-entry-month" className="w-full data-[size=default]:h-10">
                            <SelectValue placeholder="בחר חודש">{(v: string | null) => (v ? monthLabel(v) : null)}</SelectValue>
                          </SelectTrigger>
                          <SelectContent>
                            {monthOptions.map((m) => (
                              <SelectItem key={m} value={m}>{monthLabel(m)}</SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                        {err('month') && <p className="text-[12px] font-semibold text-red-500 text-start">⚠️ {err('month')}</p>}
                      </div>
                    )}

                    {isExpense && (
                      <Field
                        id="fin-entry-invoice"
                        label="מספר חשבונית"
                        value={form.invoice_number}
                        onChange={(v) => set('invoice_number', v)}
                        disabled={disabled}
                        dir="ltr"
                        tabularNums
                      />
                    )}
                  </div>

                  {duplicate && (
                    <div className="flex items-start gap-2 rounded-md border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">
                      <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-600" />
                      <p>
                        קיימת כבר הוצאה עם אותו ספק ומספר חשבונית:{' '}
                        <span className="font-semibold">{duplicate.supplier_name || 'ללא שם ספק'}</span>,{' '}
                        <span dir="ltr" className="font-num tabular-nums">{fmtDate(duplicate.payment_date)}</span>,{' '}
                        <span dir="ltr" className="font-num tabular-nums">{ils(duplicate.amount)}</span>.
                        {' '}אפשר לשמור בכל זאת.
                      </p>
                    </div>
                  )}
                </div>
              </Section>

              <Section title="תיאור והערות" icon={FileText} iconTone="blue">
                <div className="space-y-4 py-2">
                  <div className="space-y-2">
                    <Label htmlFor="fin-entry-description" className="text-base font-medium text-muted-foreground">
                      {isExpense ? 'תיאור לדיירים' : 'תיאור'}
                    </Label>
                    <Textarea
                      id="fin-entry-description"
                      value={form.description}
                      onChange={(e) => set('description', e.target.value)}
                      disabled={disabled}
                      maxLength={500}
                      placeholder={isExpense ? 'למשל: חשמל לחדר המדרגות — ספטמבר' : 'למשל: דמי ניהול ספטמבר'}
                    />
                    <p className="text-[12px] text-slate-500 text-start">יוצג בעתיד לבעלי הדירות בפורטל, לצד הסעיף והסכום.</p>
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="fin-entry-note" className="text-base font-medium text-muted-foreground">הערה פנימית</Label>
                    <Textarea
                      id="fin-entry-note"
                      value={form.internal_note}
                      onChange={(e) => set('internal_note', e.target.value)}
                      disabled={disabled}
                      maxLength={2000}
                    />
                    <p className="text-[12px] text-slate-500 text-start">פנימי — לא יוצג לדיירים.</p>
                  </div>
                </div>
              </Section>

              <Section title="קבצים מצורפים" icon={Paperclip} iconTone="violet">
                <div className="space-y-4 py-2">
                  {existingDocs.length > 0 && (
                    <ul className="space-y-2">
                      {existingDocs.map((d) => {
                        const { Icon, tone } = fileMeta(d.mime);
                        return (
                          <li key={d.id} className="flex items-center gap-3 rounded-lg border border-line bg-white p-3">
                            <span className={cn('grid h-9 w-9 shrink-0 place-items-center rounded-lg', tone)}>
                              <Icon className="h-4 w-4" />
                            </span>
                            <a
                              href={d.url}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="min-w-0 flex-1 truncate text-sm font-medium text-blue-700 hover:underline"
                              title={d.original_name}
                            >
                              {d.original_name}
                            </a>
                            <span className="shrink-0 font-num text-xs tabular-nums text-slate-500">{formatBytes(d.size)}</span>
                            <DriveStatusIcon status={d.drive_status} error={d.drive_error} attempts={d.drive_attempts} />
                            {canEdit && (
                              <button
                                type="button"
                                onClick={() => setDocToRemove(d)}
                                disabled={submitting}
                                aria-label={`הסר ${d.original_name}`}
                                className="grid h-11 w-11 shrink-0 place-items-center rounded-lg text-slate-400 transition-colors hover:bg-red-50 hover:text-red-600 disabled:opacity-50"
                              >
                                <Trash2 className="h-4 w-4" />
                              </button>
                            )}
                          </li>
                        );
                      })}
                    </ul>
                  )}
                  {canEdit && (
                    <AttachmentPicker
                      items={staged}
                      onChange={setStaged}
                      disabled={disabled}
                      maxFiles={remainingFiles}
                      uploadUrl="/api/finance/documents"
                      policy={RECEIPT_POLICY}
                      capture
                      label={existingDocs.length > 0 ? 'הוספת קבצים' : 'קבצים מצורפים'}
                    />
                  )}
                  <p className="text-[12px] text-slate-500 text-start">כל קובץ מגובה אוטומטית ל-Google Drive אחרי השמירה. כשל בגיבוי לא מונע שמירה.</p>
                </div>
              </Section>
            </div>
          </div>

          <PanelFooter
            onClose={requestClose}
            onSave={() => void save(false)}
            saveDisabled={!canSubmit}
            saveDisabledReason={!canEdit ? 'אין הרשאה — כניסה כצופה' : undefined}
            saveLabel={submitting ? 'שומר…' : uploading ? 'מעלה קבצים…' : 'שמור וסגור'}
            secondaryAction={!isEdit && canEdit ? { label: 'שמור והוסף עוד', onClick: () => void save(true), disabled: !canSubmit } : undefined}
            onDelete={isEdit && canEdit && onDelete ? onDelete : undefined}
            deleteLabel="מחק שורה"
          />
        </SheetContent>
      </Sheet>

      <AlertDialog open={confirmClose} onOpenChange={setConfirmClose}>
        <AlertDialogContent dir="rtl">
          <AlertDialogHeader>
            <AlertDialogTitle>לצאת ללא שמירה?</AlertDialogTitle>
            <AlertDialogDescription>השינויים שביצעת לא יישמרו{staged.length > 0 ? ' והקבצים שהועלו יוסרו' : ''}.</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>המשך עריכה</AlertDialogCancel>
            <AlertDialogAction onClick={confirmDiscardClose} className="bg-destructive text-white hover:bg-destructive/90">
              צא ללא שמירה
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={docToRemove !== null} onOpenChange={(o) => { if (!o) setDocToRemove(null); }}>
        <AlertDialogContent dir="rtl">
          <AlertDialogHeader>
            <AlertDialogTitle>להסיר את הקובץ?</AlertDialogTitle>
            <AlertDialogDescription>
              {docToRemove ? `«${docToRemove.original_name}» יוסר מהשורה ומהאחסון. עותק שכבר גובה ל-Google Drive יישאר שם.` : ''}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>ביטול</AlertDialogCancel>
            <AlertDialogAction onClick={() => { if (docToRemove) void removeExistingDoc(docToRemove); }} className="bg-destructive text-white hover:bg-destructive/90">
              הסר
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
