'use client';

// Sending a document to suppliers — e-mail (the PDF attached) and / or WhatsApp
// (the message + the PDF as a file), through the app's existing channels. A
// request goes to any number of suppliers, each with a personal link; a
// purchase order goes to its own supplier. A hand-typed supplier (not in the
// suppliers list) is a row of its own, reached through the e-mail / phone on the
// document; a channel it has no detail for is blocked with a plain message
// instead of failing on the server. Per-recipient results are shown, a
// failure of one never cancels the others.

import { useEffect, useMemo, useState } from 'react';
import { toast } from 'sonner';
import { CheckCircle2, Mail, MessageCircle, Search, Send, Truck, X, XCircle } from 'lucide-react';
import { Sheet, SheetContent, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { Section } from '@/components/side-panel/Section';
import { PanelFooter } from '@/components/side-panel/PanelFooter';
import { useEscapeKey } from '@/lib/hooks/useEscapeKey';
import { docHeading, MANUAL_PARTY } from '@/lib/purchasing/model';
import type { DocumentDetail, SupplierBrief } from './types';

/** A bordered, fully clickable checkbox row. The row is a div (not a label): a
 *  <label> around Base UI's checkbox lets one click toggle it twice. */
function CheckRow({
  checked, onToggle, disabled, name, children, className,
}: { checked: boolean; onToggle: () => void; disabled?: boolean; name: string; children: React.ReactNode; className?: string }) {
  return (
    <div
      onClick={(e) => {
        if (disabled || (e.target as HTMLElement).closest('[data-slot="checkbox"], input[type="checkbox"]')) return;
        onToggle();
      }}
      className={`flex min-h-11 items-center gap-3 rounded-lg border border-line bg-white px-3 py-2 ${disabled ? '' : 'cursor-pointer'} ${className ?? ''}`}
    >
      <Checkbox checked={checked} disabled={disabled} onCheckedChange={() => onToggle()} aria-label={name} />
      {children}
    </div>
  );
}

interface Result { supplier_id: string; supplier_name: string; channel: 'email' | 'whatsapp'; ok: boolean; error?: string }

interface Props {
  open: boolean;
  detail: DocumentDetail;
  suppliers: SupplierBrief[];
  onOpenChange: (o: boolean) => void;
  onSent: () => void;
}

/** One row of the recipients list: a listed supplier, or the document's own
 *  hand-typed one (key MANUAL_PARTY). */
interface Row { key: string; name: string; email: string; phone: string; manual: boolean }

export function SendSheet({ open, detail, suppliers, onOpenChange, onSent }: Props) {
  const doc = detail.document;
  const isRfq = doc.doc_type === 'rfq';
  const hasManual = doc.supplier_id === null && !!doc.supplier_name;
  const ownKey = doc.supplier_id ?? MANUAL_PARTY;
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [email, setEmail] = useState(true);
  const [whatsapp, setWhatsapp] = useState(false);
  const [q, setQ] = useState('');
  const [sending, setSending] = useState(false);
  const [results, setResults] = useState<Result[] | null>(null);

  useEffect(() => {
    if (!open) return;
    setPicked(new Set(!isRfq ? [ownKey] : []));
    setEmail(true);
    setWhatsapp(false);
    setQ('');
    setResults(null);
  }, [open, isRfq, ownKey]);

  const visible = useMemo<Row[]>(() => {
    const manualRow: Row[] = hasManual
      ? [{ key: MANUAL_PARTY, name: doc.supplier_name ?? '', email: doc.supplier_email ?? '', phone: doc.supplier_phone ?? '', manual: true }]
      : [];
    const listed = (isRfq ? suppliers : suppliers.filter((s) => s.id === doc.supplier_id)).map((s): Row => ({
      key: s.id, name: s.name, email: s.email, phone: s.mobile || s.phone, manual: false,
    }));
    const needle = q.trim().toLowerCase();
    const all = [...manualRow, ...listed];
    return needle ? all.filter((r) => `${r.name} ${r.email} ${r.phone}`.toLowerCase().includes(needle)) : all;
  }, [suppliers, isRfq, hasManual, doc.supplier_id, doc.supplier_name, doc.supplier_email, doc.supplier_phone, q]);

  // A channel the hand-typed supplier has no detail for is blocked up front.
  const blocked = useMemo(() => {
    const m = visible.find((r) => r.manual && picked.has(r.key));
    if (!m) return null;
    const missing: string[] = [];
    if (email && !m.email.trim()) missing.push('מייל');
    if (whatsapp && !m.phone.trim()) missing.push('טלפון ל-WhatsApp');
    return missing.length ? `לספק "${m.name}" אין ${missing.join(' ו')} על המסמך — הוסיפו בעריכת המסמך או בטלו את הערוץ.` : null;
  }, [visible, picked, email, whatsapp]);

  useEscapeKey(open, () => requestClose());
  function requestClose() { if (!sending) onOpenChange(false); }

  function toggle(id: string) {
    setPicked((p) => {
      const n = new Set(p);
      if (n.has(id)) n.delete(id); else n.add(id);
      return n;
    });
  }

  async function send() {
    if (picked.size === 0) { toast.error('יש לבחור ספק אחד לפחות'); return; }
    if (!email && !whatsapp) { toast.error('יש לבחור מייל ו/או WhatsApp'); return; }
    if (blocked) { toast.error(blocked); return; }
    setSending(true);
    try {
      const res = await fetch(`/api/purchasing/documents/${doc.id}/send`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ supplier_ids: [...picked], email, whatsapp }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok && !Array.isArray(body.results)) {
        toast.error(typeof body.error === 'string' ? body.error : 'השליחה נכשלה');
        return;
      }
      setResults(body.results as Result[]);
      if (body.failed_count === 0) toast.success('נשלח בהצלחה');
      else toast.error(`${body.failed_count} שליחות נכשלו`);
      onSent();
    } catch {
      toast.error('השליחה נכשלה');
    } finally {
      setSending(false);
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
              <SheetTitle className="text-2xl font-bold text-white">שליחה לספקים</SheetTitle>
              <p className="mt-1 truncate text-sm text-white/70">{docHeading(doc.doc_type, doc.number ?? 0)}</p>
            </div>
            <button
              type="button" onClick={requestClose} aria-label="סגור" disabled={sending}
              className="flex h-11 w-11 shrink-0 items-center justify-center rounded-lg border border-white/25 bg-white/5 text-white transition-colors hover:border-white/50 hover:bg-white/15 disabled:opacity-60"
            >
              <X className="h-5 w-5" />
            </button>
          </div>
        </SheetHeader>

        <div className="flex-1 space-y-5 overflow-y-auto bg-slate-50/60 p-5">
          <Section title="ערוץ שליחה" icon={Send} iconTone="blue">
            <div className="space-y-2 py-2">
              <CheckRow checked={email} onToggle={() => setEmail((v) => !v)} name="מייל">
                <Mail className="h-4 w-4 text-ink-3" aria-hidden />
                <span className="text-sm font-semibold text-ink">מייל</span>
                <span className="text-xs text-ink-3">ה-PDF מצורף להודעה</span>
              </CheckRow>
              <CheckRow checked={whatsapp} onToggle={() => setWhatsapp((v) => !v)} name="WhatsApp">
                <MessageCircle className="h-4 w-4 text-ink-3" aria-hidden />
                <span className="text-sm font-semibold text-ink">WhatsApp</span>
                <span className="text-xs text-ink-3">הודעה + ה-PDF כקובץ</span>
              </CheckRow>
              {isRfq && <p className="text-[12px] text-slate-500">כל ספק מקבל קישור אישי להגשת ההצעה. שליחה חוזרת משתמשת באותו קישור.</p>}
            </div>
          </Section>

          <Section title={isRfq ? 'ספקים' : 'ספק'} icon={Truck} iconTone="emerald">
            <div className="space-y-3 py-2">
              {isRfq && (
                <div className="relative">
                  <Search className="pointer-events-none absolute start-3 top-1/2 h-4 w-4 -translate-y-1/2 text-ink-3" />
                  <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="חיפוש ספק" className={`h-10 ps-9 ${q ? 'pe-9' : ''}`} />
                  {q && (
                    <button type="button" aria-label="נקה חיפוש" onClick={() => setQ('')}
                      className="absolute end-2 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-600">
                      <X className="h-4 w-4" />
                    </button>
                  )}
                </div>
              )}
              <ul className="space-y-2">
                {visible.map((s) => (
                  <li key={s.key} data-send-row={s.key}>
                    <CheckRow checked={picked.has(s.key)} disabled={!isRfq} onToggle={() => toggle(s.key)} name={s.name} className="py-3">
                      <span className="min-w-0 flex-1">
                        <span className="block text-sm font-semibold text-ink">
                          {s.name}
                          {s.manual && <span className="ms-2 rounded-full bg-slate-100 px-2 py-0.5 text-xs font-semibold text-slate-600">ספק שהוקלד</span>}
                        </span>
                        <span className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-ink-3">
                          <span className={email && !s.email ? 'text-rose-600' : ''}>{s.email || 'אין מייל'}</span>
                          <span dir="ltr" className={`tabular-nums ${whatsapp && !s.phone ? 'text-rose-600' : ''}`}>{s.phone || 'אין טלפון'}</span>
                        </span>
                      </span>
                    </CheckRow>
                  </li>
                ))}
                {visible.length === 0 && <li className="rounded-lg border border-line bg-white p-4 text-center text-sm text-ink-3">לא נמצאו ספקים</li>}
              </ul>
              {blocked && <p className="rounded-md border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900" data-send-blocked>{blocked}</p>}
            </div>
          </Section>

          {results && (
            <Section title="תוצאות השליחה" icon={Send} iconTone="violet">
              <ul className="space-y-2 py-2" data-send-results>
                {results.map((r, i) => (
                  <li key={`${r.supplier_id}-${r.channel}-${i}`} className="flex items-start gap-3 rounded-lg border border-line bg-white p-3 text-sm">
                    {r.ok ? <CheckCircle2 className="mt-0.5 h-4 w-4 text-emerald-600" aria-hidden /> : <XCircle className="mt-0.5 h-4 w-4 text-rose-600" aria-hidden />}
                    <span className="min-w-0 flex-1">
                      <span className="font-semibold text-ink">{r.supplier_name}</span>
                      <span className="text-ink-3"> · {r.channel === 'email' ? 'מייל' : 'WhatsApp'}</span>
                      {!r.ok && <span className="block text-xs text-rose-600">{r.error}</span>}
                    </span>
                  </li>
                ))}
              </ul>
            </Section>
          )}
        </div>

        <PanelFooter
          onClose={requestClose} onSave={send} saveDisabled={sending || picked.size === 0 || !!blocked}
          saveLabel={sending ? 'שולח…' : results ? 'שלח שוב' : 'שלח'} saveIcon={Send}
        />
      </SheetContent>
    </Sheet>
  );
}
