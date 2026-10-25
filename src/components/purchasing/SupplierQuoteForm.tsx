'use client';

// The supplier's public page: the request (details, lines, files), one unit
// price per line (typed before or including VAT), validity date, notes and an
// optional file. The supplier may submit and amend through the due date;
// afterwards the page is read-only.

import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import {
  Building2, CheckCircle2, FileText, Info, Loader2, Lock, Mail, Paperclip, Phone, Send, Trash2, UploadCloud, User,
} from 'lucide-react';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { cn } from '@/lib/utils';
import { formatFileSize } from '@/lib/decisions';
import {
  docHeading, formatDocDate, formatIls, formatQty, formatStampIL, formatVatRate, lineTotal, plusDays, PURCHASING_LIMITS,
  summarizeQuote, todayIsrael, type PriceMode,
} from '@/lib/purchasing/model';
import { PURCHASING_FILE_ACCEPT, validatePurchasingFile } from '@/lib/purchasing/files';
import { parseNumber } from './lines';

interface PublicFile { id: string; name: string; size: number; mine?: boolean }
interface PublicView {
  company_name: string;
  has_logo: boolean;
  supplier_name: string;
  rfq: {
    number: number; title: string; doc_date: string; due_date: string; notes: string; vat_rate: number;
    requester: { name: string; phone: string; email: string };
  };
  open: boolean;
  lines: Array<{ id: string; sort_order: number; description: string; quantity: number }>;
  rfq_files: PublicFile[];
  quote: null | {
    price_mode: PriceMode;
    /** The prices as the supplier typed them. */
    valid_until: string | null; notes: string; prices: Record<string, number>;
    submitted_at: string; updated_at: string; files: PublicFile[];
  };
  limits: { files: number; file_bytes: number };
}

type Phase = 'loading' | 'missing' | 'error' | 'ready';

const MODES: ReadonlyArray<{ value: PriceMode; label: string }> = [
  { value: 'excl', label: 'המחירים לפני מע״מ' },
  { value: 'incl', label: 'המחירים כוללים מע״מ' },
];

const CARD = 'rounded-3xl border border-line bg-white p-4 shadow-sm sm:p-6';
const LABEL = 'text-sm font-bold text-ink';

export function SupplierQuoteForm({ token }: { token: string }) {
  const base = `/api/public/quote/${encodeURIComponent(token)}`;
  const [phase, setPhase] = useState<Phase>('loading');
  const [view, setView] = useState<PublicView | null>(null);
  const [mode, setMode] = useState<PriceMode>('excl');
  const [prices, setPrices] = useState<Record<string, string>>({});
  const [validUntil, setValidUntil] = useState('');
  const [notes, setNotes] = useState('');
  const [pending, setPending] = useState<File[]>([]);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null);
  const [showErrors, setShowErrors] = useState(false);
  const [logoBroken, setLogoBroken] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);

  const apply = useCallback((v: PublicView) => {
    setView(v);
    setMode(v.quote?.price_mode ?? 'excl');
    setPrices(Object.fromEntries(Object.entries(v.quote?.prices ?? {}).map(([k, n]) => [k, String(n)])));
    // No saved quote yet: the validity starts at today + 14 days (Israel date).
    setValidUntil(v.quote ? (v.quote.valid_until ?? '') : plusDays(todayIsrael(), 14));
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
    return <Plain><div className="grid place-items-center p-16 text-ink-3"><Loader2 className="h-6 w-6 animate-spin" aria-label="טוען" /></div></Plain>;
  }
  if (phase === 'missing') {
    return <Plain><div className={cn(CARD, 'text-center')} data-quote-missing><h1 className="text-xl font-bold text-ink">הקישור אינו תקף</h1><p className="mt-2 text-sm text-ink-3">ייתכן שהבקשה בוטלה או שהקישור הועתק לא במלואו. נא לפנות למי ששלח אותו.</p></div></Plain>;
  }
  if (phase === 'error' || !view) {
    return <Plain><div className={cn(CARD, 'text-center')}><h1 className="text-xl font-bold text-ink">אירעה תקלה בטעינה</h1><p className="mt-2 text-sm text-ink-3">נא לרענן את הדף ולנסות שוב.</p></div></Plain>;
  }

  const locked = !view.open;
  const vatRate = view.rfq.vat_rate;
  const missing = view.lines.filter((l) => parseNumber(prices[l.id] ?? '') === null);
  const summary = summarizeQuote(view.lines.map((l) => ({ quantity: l.quantity, entered: parseNumber(prices[l.id] ?? '') })), mode, vatRate);
  const mineCount = view.quote?.files.filter((f) => f.mine).length ?? 0;
  const requester = view.rfq.requester;

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
        // The prices go as typed; the server turns them into before-VAT prices.
        body: JSON.stringify({
          price_mode: mode,
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

  const header = (
    <header className="bg-gradient-to-br from-slate-900 via-blue-950 to-blue-900 px-4 pb-24 pt-8 text-white sm:px-6">
      <div className="mx-auto flex w-full max-w-3xl items-start gap-4 sm:gap-6">
        <div className="min-w-0 flex-1 space-y-1">
          <h1 className="text-2xl font-extrabold leading-tight sm:text-3xl" data-quote-heading>{docHeading('rfq', view.rfq.number)}</h1>
          <p className="text-sm text-white/70 sm:text-base">שלום {view.supplier_name} · תאריך הבקשה {formatDocDate(view.rfq.doc_date)}</p>
          {(requester.name || requester.phone || requester.email) && (
            <div className="!mt-4 flex flex-wrap items-center gap-x-5 gap-y-2 border-t border-white/15 pt-4 text-sm text-white" data-quote-requester>
              {requester.name && (
                <span className="inline-flex items-center gap-2">
                  <User className="h-4 w-4 text-white/60" aria-hidden />
                  <span className="text-white/60">מבקש:</span>
                  <strong className="font-bold">{requester.name}</strong>
                </span>
              )}
              {requester.phone && (
                <span className="inline-flex items-center gap-2" dir="ltr">
                  <Phone className="h-4 w-4 text-white/60" aria-hidden />
                  <span className="tabular-nums">{requester.phone}</span>
                </span>
              )}
              {requester.email && (
                <span className="inline-flex items-center gap-2" dir="ltr">
                  <Mail className="h-4 w-4 text-white/60" aria-hidden />
                  <span className="break-all">{requester.email}</span>
                </span>
              )}
            </div>
          )}
        </div>
        <div className="flex w-20 shrink-0 flex-col items-center gap-2 text-center sm:w-28" data-quote-brand>
          <div className="grid h-16 w-16 place-items-center overflow-hidden rounded-2xl bg-white p-1.5 shadow-lg sm:h-20 sm:w-20">
            {view.has_logo && !logoBroken ? (
              // eslint-disable-next-line @next/next/no-img-element -- a token-gated stream, not an optimisable static asset
              <img src={`${base}/logo`} alt={view.company_name} onError={() => setLogoBroken(true)} className="max-h-full max-w-full object-contain" data-quote-logo />
            ) : (
              <Building2 className="h-8 w-8 text-brand" aria-hidden data-quote-logo-fallback />
            )}
          </div>
          {view.company_name && <p className="text-xs font-bold leading-snug text-white sm:text-sm">{view.company_name}</p>}
        </div>
      </div>
    </header>
  );

  return (
    <main dir="rtl" className="min-h-screen bg-slate-100 pb-10">
      {header}
      <div className="mx-auto -mt-16 w-full max-w-3xl space-y-5 px-4 sm:px-6">
        <section className={cn(CARD, 'space-y-5')} data-quote-lines>
          {locked ? (
            <div className="flex items-start gap-3 rounded-xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900" data-quote-locked>
              <Lock className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
              <span>תאריך היעד להגשה ({formatDocDate(view.rfq.due_date)}) חלף — הדף נעול לעריכה. {view.quote ? 'ההצעה ששלחתם מוצגת לקריאה בלבד.' : 'לא התקבלה הצעה בקישור זה.'}</span>
            </div>
          ) : (
            <div className="flex items-start gap-3 rounded-xl border border-blue-200 bg-blue-50 p-4 text-sm text-blue-900" data-quote-info>
              <Info className="mt-0.5 h-5 w-5 shrink-0 text-blue-700" aria-hidden />
              <span>אפשר להגיש הצעה ולתקן אותה עד <strong className="tabular-nums">{formatDocDate(view.rfq.due_date)}</strong>. הזן מחיר ליחידה בכל שורה.</span>
            </div>
          )}

          {(view.rfq.title || view.rfq.notes) && (
            <div className="space-y-1 rounded-xl border border-line bg-surface-2 p-4">
              {view.rfq.title && <p className="text-sm font-bold text-ink">{view.rfq.title}</p>}
              {view.rfq.notes && <p className="whitespace-pre-wrap text-sm text-ink-2">{view.rfq.notes}</p>}
            </div>
          )}

          {view.rfq_files.length > 0 && (
            <div className="space-y-2">
              <h2 className="flex items-center gap-2 text-sm font-semibold text-ink-3"><Paperclip className="h-4 w-4" aria-hidden />קבצים מצורפים לבקשה</h2>
              {view.rfq_files.map((f) => (
                <a key={f.id} href={`${base}/files/${f.id}`} className="flex min-h-11 items-center gap-3 rounded-lg border border-line bg-white px-3 py-2 hover:bg-slate-50">
                  <FileText className="h-4 w-4 shrink-0 text-rose-600" aria-hidden />
                  <span className="min-w-0 flex-1 truncate text-sm font-semibold text-ink">{f.name}</span>
                  <span className="text-xs tabular-nums text-ink-3">{formatFileSize(f.size)}</span>
                </a>
              ))}
            </div>
          )}

          <div className="flex flex-wrap items-center justify-between gap-3">
            <h2 className="text-lg font-extrabold text-ink">פריטים</h2>
            <ModeToggle mode={mode} onChange={setMode} disabled={locked || saving} />
          </div>

          <div className="overflow-hidden rounded-2xl border border-line">
            <div className="grid grid-cols-[minmax(0,1fr)_2.75rem_6.5rem_5rem] items-center gap-2 border-b border-line bg-surface-2 px-3 py-3 text-xs font-semibold text-ink-3 sm:grid-cols-[minmax(0,1fr)_4rem_9rem_7rem] sm:gap-3 sm:px-4 sm:text-sm">
              <span>פריט</span>
              <span className="text-center">כמות</span>
              <span className="text-center">מחיר ליחידה (₪)</span>
              <span>סה״כ לשורה</span>
            </div>
            {view.lines.map((l) => {
              const price = parseNumber(prices[l.id] ?? '');
              const bad = showErrors && price === null;
              return (
                <div key={l.id} className="grid grid-cols-[minmax(0,1fr)_2.75rem_6.5rem_5rem] items-center gap-2 border-b border-line px-3 py-3 last:border-b-0 sm:grid-cols-[minmax(0,1fr)_4rem_9rem_7rem] sm:gap-3 sm:px-4">
                  <p className="min-w-0 text-sm font-semibold text-ink">{l.description}</p>
                  <p className="text-center text-sm font-semibold tabular-nums text-ink-2">{formatQty(l.quantity)}</p>
                  <Input
                    value={prices[l.id] ?? ''} dir="ltr" inputMode="decimal" placeholder="0.00" aria-label={`מחיר ליחידה — ${l.description}`}
                    disabled={locked || saving} aria-invalid={bad ? true : undefined}
                    onChange={(e) => setPrices((p) => ({ ...p, [l.id]: e.target.value }))}
                    className={cn('h-11 rounded-xl text-center text-base font-semibold tabular-nums', bad && 'border-red-400 bg-red-50 focus-visible:ring-red-200')}
                  />
                  <p className="text-sm font-bold tabular-nums text-ink" dir="ltr">
                    {price === null ? '—' : formatIls(lineTotal({ quantity: l.quantity, unit_price: price }))}
                  </p>
                </div>
              );
            })}
          </div>

          <dl className="space-y-3 rounded-2xl border border-line bg-surface-2 p-4" data-quote-summary>
            <SummaryRow label="סה״כ לפני מע״מ" value={formatIls(summary.subtotal)} testId="data-quote-subtotal" />
            <SummaryRow label={`מע״מ ${formatVatRate(vatRate)}`} value={formatIls(summary.vat)} testId="data-quote-vat" />
            <div className="flex items-center justify-between gap-3 border-t border-line pt-3">
              <dt className="text-base font-extrabold text-ink">סה״כ כולל מע״מ</dt>
              <dd className="text-2xl font-extrabold tabular-nums text-blue-800" dir="ltr" data-quote-total>{formatIls(summary.total)}</dd>
            </div>
          </dl>
        </section>

        <section className={cn(CARD, 'space-y-5')}>
          <div className="space-y-2">
            <label htmlFor="q-valid" className={cn(LABEL, 'block')}>תוקף ההצעה</label>
            <input
              id="q-valid" type="date" value={validUntil} onChange={(e) => setValidUntil(e.target.value)} disabled={locked || saving}
              onClick={(e) => {
                const el = e.currentTarget as HTMLInputElement & { showPicker?: () => void };
                try { el.showPicker?.(); } catch { /* fallback to the native icon */ }
              }}
              className="flex h-11 w-full cursor-pointer rounded-xl border border-input bg-transparent px-3 py-2 text-base shadow-xs outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-50 md:w-64"
            />
            <p className="text-sm text-ink-3">ברירת מחדל: 14 יום מהיום</p>
          </div>

          <div className="space-y-2">
            <label htmlFor="q-notes" className={cn(LABEL, 'block')}>הערות</label>
            <Textarea id="q-notes" value={notes} rows={4} disabled={locked || saving} className="rounded-xl"
              onChange={(e) => setNotes(e.target.value.slice(0, PURCHASING_LIMITS.quoteNotesMax))} placeholder="תנאי תשלום, זמן אספקה, הבהרות..." />
          </div>

          <div className="space-y-2">
            <p className={LABEL}>קובץ מצורף <span className="font-normal text-ink-3">(לא חובה)</span></p>
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
                className="flex min-h-28 w-full flex-col items-center justify-center gap-2 rounded-2xl border border-dashed border-line-strong bg-white px-6 py-6 text-center transition-colors hover:border-brand hover:bg-brand-soft/40">
                <UploadCloud className="h-6 w-6 text-brand" aria-hidden />
                <span className="text-sm font-bold text-ink">הוספת קובץ</span>
                <span className="text-xs text-ink-3">PDF, תמונות, Word, Excel · עד {PURCHASING_LIMITS.supplierFilesMax} קבצים, {PURCHASING_LIMITS.supplierFileBytes / (1024 * 1024)}MB לקובץ</span>
              </button>
            )}
            <input ref={fileInput} type="file" multiple hidden accept={PURCHASING_FILE_ACCEPT} onChange={(e) => { stage(e.target.files); e.target.value = ''; }} />
          </div>

          {message && (
            <div role="status" data-quote-message={message.kind}
              className={cn('flex items-start gap-3 rounded-xl border p-4 text-sm', message.kind === 'ok' ? 'border-emerald-200 bg-emerald-50 text-emerald-900' : 'border-red-200 bg-red-50 text-red-900')}>
              {message.kind === 'ok' && <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />}
              <span>{message.text}</span>
            </div>
          )}

          {!locked && (
            <div className="space-y-2">
              <button
                type="button" onClick={submit} disabled={saving} data-quote-submit
                className="inline-flex h-14 w-full items-center justify-center gap-2 rounded-xl bg-brand px-6 text-base font-bold text-white shadow-md transition-colors hover:bg-brand-dark disabled:opacity-60"
              >
                {saving ? <Loader2 className="h-5 w-5 animate-spin" aria-hidden /> : null}
                {view.quote ? 'עדכון ההצעה' : 'שליחת ההצעה'}
                {!saving && <Send className="h-5 w-5" aria-hidden />}
              </button>
              {view.quote && <p className="text-center text-xs text-ink-3">נשלחה לאחרונה: {formatStampIL(view.quote.updated_at)}</p>}
            </div>
          )}
        </section>

        <p className="text-center text-sm text-ink-3" data-quote-footer>
          הקישור אישי ומיועד לך בלבד{view.company_name ? ` · ${view.company_name}` : ''}
        </p>
      </div>
    </main>
  );
}

/** "Prices before VAT | prices include VAT" — a radio group (arrow keys move it). */
function ModeToggle({ mode, onChange, disabled }: { mode: PriceMode; onChange: (m: PriceMode) => void; disabled: boolean }) {
  function onKey(e: React.KeyboardEvent) {
    if (disabled) return;
    if (['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(e.key)) {
      e.preventDefault();
      onChange(mode === 'excl' ? 'incl' : 'excl');
    }
  }
  return (
    <div role="radiogroup" aria-label="סוג המחירים" onKeyDown={onKey} data-quote-mode={mode}
      className="inline-flex gap-1 rounded-xl border border-line bg-slate-100 p-1">
      {MODES.map((m) => {
        const on = mode === m.value;
        return (
          <button
            key={m.value} type="button" role="radio" aria-checked={on} tabIndex={on ? 0 : -1} disabled={disabled}
            onClick={() => onChange(m.value)} data-mode={m.value}
            className={cn(
              'min-h-11 rounded-lg px-4 py-2 text-sm font-bold transition-colors disabled:cursor-not-allowed',
              on ? 'bg-white text-blue-700 shadow-sm' : 'text-ink-3 hover:text-ink',
            )}
          >
            {m.label}
          </button>
        );
      })}
    </div>
  );
}

function SummaryRow({ label, value, testId }: { label: string; value: string; testId: string }) {
  return (
    <div className="flex items-center justify-between gap-3">
      <dt className="text-sm text-ink-3">{label}</dt>
      <dd className="text-base font-bold tabular-nums text-ink" dir="ltr" {...{ [testId]: '' }}>{value}</dd>
    </div>
  );
}

function Plain({ children }: { children: ReactNode }) {
  return (
    <main dir="rtl" className="min-h-screen bg-slate-100">
      <div className="mx-auto w-full max-w-3xl space-y-5 px-4 py-8 sm:px-6">{children}</div>
    </main>
  );
}
