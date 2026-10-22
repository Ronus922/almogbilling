'use client';

// The supplier's public page: the request (details, lines, files), one unit
// price per line, validity date, notes and an optional file. The supplier may
// submit and amend through the due date; afterwards the page is read-only.

import { useCallback, useEffect, useRef, useState } from 'react';
import { CheckCircle2, FileText, Loader2, Lock, Paperclip, Trash2, UploadCloud } from 'lucide-react';
import { Card } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { cn } from '@/lib/utils';
import { formatFileSize } from '@/lib/decisions';
import {
  docHeading, formatDocDate, formatIls, formatQty, formatStampIL, lineTotal, PURCHASING_LIMITS, round2,
} from '@/lib/purchasing/model';
import { PURCHASING_FILE_ACCEPT, validatePurchasingFile } from '@/lib/purchasing/files';
import { parseNumber } from './lines';

interface PublicFile { id: string; name: string; size: number; mine?: boolean }
interface PublicView {
  company_name: string;
  supplier_name: string;
  rfq: { number: number; title: string; doc_date: string; due_date: string; notes: string };
  open: boolean;
  lines: Array<{ id: string; sort_order: number; description: string; quantity: number }>;
  rfq_files: PublicFile[];
  quote: null | {
    valid_until: string | null; notes: string; prices: Record<string, number>;
    submitted_at: string; updated_at: string; files: PublicFile[];
  };
  limits: { files: number; file_bytes: number };
}

type Phase = 'loading' | 'missing' | 'error' | 'ready';

export function SupplierQuoteForm({ token }: { token: string }) {
  const base = `/api/public/quote/${encodeURIComponent(token)}`;
  const [phase, setPhase] = useState<Phase>('loading');
  const [view, setView] = useState<PublicView | null>(null);
  const [prices, setPrices] = useState<Record<string, string>>({});
  const [validUntil, setValidUntil] = useState('');
  const [notes, setNotes] = useState('');
  const [pending, setPending] = useState<File[]>([]);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null);
  const [showErrors, setShowErrors] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);

  const apply = useCallback((v: PublicView) => {
    setView(v);
    setPrices(Object.fromEntries(Object.entries(v.quote?.prices ?? {}).map(([k, n]) => [k, String(n)])));
    setValidUntil(v.quote?.valid_until ?? '');
    setNotes(v.quote?.notes ?? '');
  }, []);

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const res = await fetch(base, { cache: 'no-store' });
        if (!alive) return;
        if (res.status === 404) { setPhase('missing'); return; }
        if (!res.ok) { setPhase('error'); return; }
        apply(await res.json());
        setPhase('ready');
      } catch {
        if (alive) setPhase('error');
      }
    })();
    return () => { alive = false; };
  }, [base, apply]);

  if (phase === 'loading') {
    return <Shell><div className="grid place-items-center p-16 text-ink-3"><Loader2 className="h-6 w-6 animate-spin" aria-label="טוען" /></div></Shell>;
  }
  if (phase === 'missing') {
    return <Shell><Card className="p-8 text-center" data-quote-missing><h1 className="text-xl font-bold text-ink">הקישור אינו תקף</h1><p className="mt-2 text-sm text-ink-3">ייתכן שהבקשה בוטלה או שהקישור הועתק לא במלואו. נא לפנות למי ששלח אותו.</p></Card></Shell>;
  }
  if (phase === 'error' || !view) {
    return <Shell><Card className="p-8 text-center"><h1 className="text-xl font-bold text-ink">אירעה תקלה בטעינה</h1><p className="mt-2 text-sm text-ink-3">נא לרענן את הדף ולנסות שוב.</p></Card></Shell>;
  }

  const locked = !view.open;
  const missing = view.lines.filter((l) => parseNumber(prices[l.id] ?? '') === null);
  const subtotal = round2(view.lines.reduce((s, l) => s + lineTotal({ quantity: l.quantity, unit_price: parseNumber(prices[l.id] ?? '') ?? 0 }), 0));
  const mineCount = view.quote?.files.filter((f) => f.mine).length ?? 0;

  function stage(list: FileList | null) {
    if (!list || !view) return;
    const next = [...pending];
    for (const f of Array.from(list)) {
      const err = validatePurchasingFile({ name: f.name, size: f.size, type: f.type }, PURCHASING_LIMITS.supplierFileBytes);
      if (err) { setMessage({ kind: 'error', text: `${f.name}: ${err}` }); continue; }
      if (mineCount + next.length >= PURCHASING_LIMITS.supplierFilesMax) {
        setMessage({ kind: 'error', text: `אפשר לצרף עד ${PURCHASING_LIMITS.supplierFilesMax} קבצים` });
        break;
      }
      next.push(f);
    }
    setPending(next);
  }

  async function submit() {
    setShowErrors(true);
    setMessage(null);
    if (missing.length > 0) { setMessage({ kind: 'error', text: 'יש להזין מחיר ליחידה בכל שורה' }); return; }
    setSaving(true);
    try {
      const res = await fetch(base, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          valid_until: validUntil || null,
          notes: notes.trim(),
          prices: Object.fromEntries(view!.lines.map((l) => [l.id, parseNumber(prices[l.id] ?? '')])),
        }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        setMessage({ kind: 'error', text: body.message ?? body.error ?? 'השליחה נכשלה' });
        if (body.error === 'closed') setView((v) => (v ? { ...v, open: false } : v));
        return;
      }
      let failedFiles = 0;
      for (const f of pending) {
        const fd = new FormData();
        fd.append('file', f);
        const up = await fetch(`${base}/files`, { method: 'POST', body: fd });
        if (!up.ok) failedFiles++;
      }
      setPending([]);
      const fresh = await fetch(base, { cache: 'no-store' });
      if (fresh.ok) apply(await fresh.json());
      setMessage({
        kind: failedFiles ? 'error' : 'ok',
        text: failedFiles
          ? `ההצעה נקלטה, אך ${failedFiles} קבצים לא הועלו.`
          : `ההצעה נקלטה. אפשר לתקן אותה עד ${formatDocDate(view!.rfq.due_date)}.`,
      });
    } catch {
      setMessage({ kind: 'error', text: 'השליחה נכשלה — נא לנסות שוב' });
    } finally {
      setSaving(false);
    }
  }

  async function removeFile(f: PublicFile) {
    if (!window.confirm('להסיר את הקובץ?')) return;
    const res = await fetch(`${base}/files/${f.id}`, { method: 'DELETE' });
    if (!res.ok) { setMessage({ kind: 'error', text: 'ההסרה נכשלה' }); return; }
    const fresh = await fetch(base, { cache: 'no-store' });
    if (fresh.ok) apply(await fresh.json());
  }

  return (
    <Shell>
      <header className="space-y-1">
        <p className="text-sm font-semibold text-ink-3">{view.company_name}</p>
        <h1 className="text-2xl font-extrabold text-ink" data-quote-heading>{docHeading('rfq', view.rfq.number)}</h1>
        {view.rfq.title && <p className="text-base font-semibold text-ink-2">{view.rfq.title}</p>}
        <p className="text-sm text-ink-3">שלום {view.supplier_name} · תאריך הבקשה {formatDocDate(view.rfq.doc_date)}</p>
      </header>

      {locked ? (
        <div className="flex items-start gap-3 rounded-lg border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900" data-quote-locked>
          <Lock className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
          <span>תאריך היעד להגשה ({formatDocDate(view.rfq.due_date)}) חלף — הדף נעול לעריכה. {view.quote ? 'ההצעה ששלחתם מוצגת לקריאה בלבד.' : 'לא התקבלה הצעה בקישור זה.'}</span>
        </div>
      ) : (
        <div className="rounded-lg border border-blue-200 bg-blue-50 p-4 text-sm text-blue-900">
          אפשר להגיש הצעה ולתקן אותה עד <strong className="tabular-nums">{formatDocDate(view.rfq.due_date)}</strong>. יש להזין מחיר ליחידה (לפני מע״מ) בכל שורה.
        </div>
      )}

      {view.rfq.notes && (
        <Card className="space-y-1 p-4">
          <h2 className="text-sm font-semibold text-ink-3">הערות</h2>
          <p className="whitespace-pre-wrap text-sm text-ink">{view.rfq.notes}</p>
        </Card>
      )}

      {view.rfq_files.length > 0 && (
        <Card className="space-y-2 p-4">
          <h2 className="flex items-center gap-2 text-sm font-semibold text-ink-3"><Paperclip className="h-4 w-4" aria-hidden />קבצים מצורפים לבקשה</h2>
          {view.rfq_files.map((f) => (
            <a key={f.id} href={`${base}/files/${f.id}`} className="flex min-h-11 items-center gap-3 rounded-lg border border-line bg-white px-3 py-2 hover:bg-slate-50">
              <FileText className="h-4 w-4 shrink-0 text-rose-600" aria-hidden />
              <span className="min-w-0 flex-1 truncate text-sm font-semibold text-ink">{f.name}</span>
              <span className="text-xs tabular-nums text-ink-3">{formatFileSize(f.size)}</span>
            </a>
          ))}
        </Card>
      )}

      <Card className="space-y-3 p-4" data-quote-lines>
        <h2 className="text-base font-bold text-ink">פריטים</h2>
        {view.lines.map((l, i) => {
          const price = parseNumber(prices[l.id] ?? '');
          const bad = showErrors && price === null;
          return (
            <div key={l.id} className="grid items-start gap-3 rounded-lg border border-line bg-white p-3 sm:grid-cols-[minmax(0,1fr)_150px_120px]">
              <div className="min-w-0">
                <p className="text-sm font-semibold text-ink">{i + 1}. {l.description}</p>
                <p className="text-xs tabular-nums text-ink-3">כמות: {formatQty(l.quantity)}</p>
              </div>
              <div className="space-y-1">
                <Label htmlFor={`price-${l.id}`} className="text-xs text-ink-3">מחיר ליחידה (₪)</Label>
                <Input
                  id={`price-${l.id}`} value={prices[l.id] ?? ''} dir="ltr" inputMode="decimal" placeholder="0.00"
                  disabled={locked || saving} aria-invalid={bad ? true : undefined}
                  onChange={(e) => setPrices((p) => ({ ...p, [l.id]: e.target.value }))}
                  className={cn('h-10 tabular-nums', bad && 'border-red-400 bg-red-50 focus-visible:ring-red-200')}
                />
              </div>
              <div className="space-y-1">
                <span className="text-xs text-ink-3">סה״כ לשורה</span>
                <p className="flex h-10 items-center text-sm font-semibold tabular-nums text-ink" dir="ltr">
                  {price === null ? '—' : formatIls(lineTotal({ quantity: l.quantity, unit_price: price }))}
                </p>
              </div>
            </div>
          );
        })}
        <div className="flex items-center justify-between rounded-lg bg-slate-50 p-3 text-base">
          <span className="font-bold text-ink">סה״כ (לפני מע״מ)</span>
          <span className="font-bold tabular-nums text-ink" dir="ltr" data-quote-subtotal>{formatIls(subtotal)}</span>
        </div>
      </Card>

      <Card className="space-y-4 p-4">
        <div className="space-y-2">
          <Label htmlFor="q-valid" className="text-base font-medium text-muted-foreground">תוקף ההצעה</Label>
          <input
            id="q-valid" type="date" value={validUntil} onChange={(e) => setValidUntil(e.target.value)} disabled={locked || saving}
            onClick={(e) => {
              const el = e.currentTarget as HTMLInputElement & { showPicker?: () => void };
              try { el.showPicker?.(); } catch { /* fallback to the native icon */ }
            }}
            className="flex h-10 w-full cursor-pointer rounded-md border border-input bg-transparent px-3 py-2 text-base shadow-xs outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-50 md:w-64 md:text-sm"
          />
        </div>
        <div className="space-y-2">
          <Label htmlFor="q-notes" className="text-base font-medium text-muted-foreground">הערות</Label>
          <Textarea id="q-notes" value={notes} rows={3} disabled={locked || saving} onChange={(e) => setNotes(e.target.value.slice(0, PURCHASING_LIMITS.quoteNotesMax))} placeholder="תנאי תשלום, זמן אספקה, הבהרות…" />
        </div>

        <div className="space-y-2">
          <Label className="text-base font-medium text-muted-foreground">קובץ מצורף (לא חובה)</Label>
          {view.quote?.files.map((f) => (
            <div key={f.id} className="flex items-center gap-3 rounded-lg border border-line bg-white p-3">
              <FileText className="h-4 w-4 shrink-0 text-rose-600" aria-hidden />
              <a href={`${base}/files/${f.id}`} className="min-w-0 flex-1 truncate text-sm font-semibold text-ink hover:underline">{f.name}</a>
              <span className="text-xs tabular-nums text-ink-3">{formatFileSize(f.size)}</span>
              {!locked && f.mine && (
                <button type="button" onClick={() => removeFile(f)} aria-label={`הסרת ${f.name}`} className="grid h-11 w-11 place-items-center rounded-lg text-ink-3 hover:bg-rose-50 hover:text-rose-600">
                  <Trash2 className="h-4 w-4" />
                </button>
              )}
            </div>
          ))}
          {pending.map((f, i) => (
            <div key={`${f.name}-${i}`} className="flex items-center gap-3 rounded-lg border border-dashed border-line-strong bg-white p-3">
              <FileText className="h-4 w-4 shrink-0 text-ink-3" aria-hidden />
              <span className="min-w-0 flex-1 truncate text-sm text-ink">{f.name}</span>
              <span className="text-xs tabular-nums text-ink-3">{formatFileSize(f.size)}</span>
              <button type="button" onClick={() => setPending((p) => p.filter((_, j) => j !== i))} aria-label={`הסרת ${f.name}`} className="grid h-11 w-11 place-items-center rounded-lg text-ink-3 hover:bg-slate-100">×</button>
            </div>
          ))}
          {!locked && mineCount + pending.length < PURCHASING_LIMITS.supplierFilesMax && (
            <button type="button" onClick={() => fileInput.current?.click()} disabled={saving}
              className="flex w-full flex-col items-center justify-center gap-1 rounded-xl border-2 border-dashed border-line-strong bg-surface-2 px-6 py-4 text-center hover:border-brand hover:bg-brand-soft/40">
              <UploadCloud className="h-5 w-5 text-brand" aria-hidden />
              <span className="text-sm font-semibold text-ink">הוספת קובץ</span>
              <span className="text-xs text-ink-3">PDF, תמונות, Word, Excel · עד {PURCHASING_LIMITS.supplierFilesMax} קבצים, 10MB לקובץ</span>
            </button>
          )}
          <input ref={fileInput} type="file" multiple hidden accept={PURCHASING_FILE_ACCEPT} onChange={(e) => { stage(e.target.files); e.target.value = ''; }} />
        </div>
      </Card>

      {message && (
        <div role="status" data-quote-message={message.kind}
          className={cn('flex items-start gap-3 rounded-lg border p-4 text-sm', message.kind === 'ok' ? 'border-emerald-200 bg-emerald-50 text-emerald-900' : 'border-red-200 bg-red-50 text-red-900')}>
          {message.kind === 'ok' && <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />}
          <span>{message.text}</span>
        </div>
      )}

      {!locked && (
        <div className="space-y-2">
          <button
            type="button" onClick={submit} disabled={saving} data-quote-submit
            className="inline-flex h-12 w-full items-center justify-center gap-2 rounded-lg bg-brand px-6 text-base font-bold text-white transition-colors hover:bg-brand-dark disabled:opacity-60 sm:w-auto"
          >
            {saving && <Loader2 className="h-4 w-4 animate-spin" aria-hidden />}
            {view.quote ? 'עדכון ההצעה' : 'שליחת ההצעה'}
          </button>
          {view.quote && <p className="text-xs text-ink-3">נשלחה לאחרונה: {formatStampIL(view.quote.updated_at)}</p>}
        </div>
      )}
    </Shell>
  );
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <main dir="rtl" className="min-h-screen bg-slate-50">
      <div className="mx-auto w-full max-w-3xl space-y-5 px-4 py-8 sm:px-6">{children}</div>
    </main>
  );
}
