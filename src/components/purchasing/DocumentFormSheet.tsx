'use client';

// CREATE / EDIT of a request for quotation or a purchase order — one Sheet
// (DESIGN §12) and ONE form for both documents, in this order only:
//   heading "<document> מספר N" (the number it would get right now)
//   תאריך מסמך * · ספק * (+ phone / e-mail / address of a hand-typed supplier)
//   תיאור · תאריך יעד להגשה (request only)
//   A REQUEST picks any number of suppliers here (chips) and ticks how to send it
//   (e-mail / WhatsApp, none by default); issuing sends in the same step.
//   פירוטים (פירוט · כמות · מחיר · סה״כ) + the three-row summary
//   הערות
//   תצוגה מקדימה · הפק את המסמך · שמור טיוטה · ביטול
// The number is allocated atomically by the server on issue; if the one shown
// was taken meanwhile the document gets the next and the user is told. The
// first document of a series asks where to start, inside the heading. A DRAFT
// is saved on the server (any device sees it), takes no number, and is opened
// from the list back into this same form; issuing it allocates the number.

import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { Eye, FilePlus2, Loader2, Save, StickyNote, X, ListChecks, Hash } from 'lucide-react';
import { Sheet, SheetContent, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Section } from '@/components/side-panel/Section';
import { Field } from '@/components/side-panel/Field';
import { useEscapeKey } from '@/lib/hooks/useEscapeKey';
import { cn } from '@/lib/utils';
import { DOC_LABEL, docHeading, PURCHASING_LIMITS, todayIsrael, type DocType } from '@/lib/purchasing/model';
import { LinesEditor } from './LinesEditor';
import { SupplierField } from './SupplierField';
import { RecipientsField } from './RecipientsField';
import { IssueResultsSheet, type IssuedInfo, type IssueResult } from './IssueResultsSheet';
import { EMAIL_RE, partiesOfDetail, recipientsPayload, type PartyDraft } from './recipients';
import { draftsToPayload, emptyLine, newLineKey, type LineDraft } from './lines';
import type { DocumentDetail, PoPrefill, SequenceState, SupplierBrief } from './types';

interface Props {
  open: boolean;
  type: DocType;
  /** null = create. An issued document = edit; a draft = continue the draft. */
  detail: DocumentDetail | null;
  prefill: PoPrefill | null;
  vatRate: number;
  sequences: SequenceState;
  suppliers: SupplierBrief[];
  onOpenChange: (o: boolean) => void;
  /** The company letterhead is missing: ask for it first. */
  onNeedCompany: () => void;
  /** `issued` false = a draft was saved (the list refreshes; no detail panel). */
  onSaved: (id: string, issued: boolean) => void;
}

interface FormState {
  docDate: string;
  supplierText: string;
  supplierId: string | null;
  phone: string;
  email: string;
  address: string;
  title: string;
  dueDate: string;
  notes: string;
  lines: LineDraft[];
}

const plusDays = (iso: string, days: number) => {
  const d = new Date(`${iso}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
};

const linesFromRows = (rows: Array<{ description: string; quantity: number; unit_price: number | null }>): LineDraft[] =>
  rows.length
    ? rows.map((l) => ({
        key: newLineKey(), description: l.description, quantity: String(l.quantity),
        unit_price: l.unit_price === null ? '' : String(l.unit_price),
      }))
    : [emptyLine()];

const dateInputClass = (invalid: boolean) => cn(
  'flex h-10 w-full cursor-pointer rounded-md border border-input bg-transparent px-3 py-2 text-base shadow-xs outline-none transition-[color,box-shadow] focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-50 md:text-sm',
  invalid && 'border-red-400 bg-red-50 focus-visible:ring-red-200',
);
const openPicker = (e: React.MouseEvent<HTMLInputElement>) => {
  const el = e.currentTarget as HTMLInputElement & { showPicker?: () => void };
  try { el.showPicker?.(); } catch { /* fallback to the native icon */ }
};

export function DocumentFormSheet({
  open, type, detail, prefill, vatRate, sequences, suppliers, onOpenChange, onNeedCompany, onSaved,
}: Props) {
  const draft = detail?.document.status === 'draft' ? detail.document : null;
  /** Editing an ISSUED document (its number is fixed); a draft behaves like a new one. */
  const editing = detail !== null && draft === null;
  const isRfq = type === 'rfq';
  const today = todayIsrael();

  const [docDate, setDocDate] = useState(today);
  const [supplierText, setSupplierText] = useState('');
  const [supplierId, setSupplierId] = useState<string | null>(null);
  const [phone, setPhone] = useState('');
  const [email, setEmail] = useState('');
  const [address, setAddress] = useState('');
  const [parties, setParties] = useState<PartyDraft[]>([]);
  const [sendEmail, setSendEmail] = useState(false);
  const [sendWhatsapp, setSendWhatsapp] = useState(false);
  const [issued, setIssued] = useState<IssuedInfo | null>(null);
  const [title, setTitle] = useState('');
  const [dueDate, setDueDate] = useState('');
  const [notes, setNotes] = useState('');
  const [startNumber, setStartNumber] = useState('');
  const [lines, setLines] = useState<LineDraft[]>([emptyLine()]);
  const [liveSeq, setLiveSeq] = useState<SequenceState>(sequences);
  const [touched, setTouched] = useState(false);
  const [lineError, setLineError] = useState<{ key?: string; message: string } | null>(null);
  const [saving, setSaving] = useState(false);
  const [previewing, setPreviewing] = useState(false);

  // Seed on open: an edit from the document, a PO from a winning quote's
  // prefill, otherwise a saved draft or empty defaults (due date two weeks out).
  useEffect(() => {
    if (!open) return;
    setTouched(false);
    setLineError(null);
    setStartNumber('');
    setLiveSeq(sequences);
    const manual = (d: DocumentDetail['document']) => ({
      phone: d.supplier_id ? '' : d.supplier_phone ?? '',
      email: d.supplier_id ? '' : d.supplier_email ?? '',
      address: d.supplier_id ? '' : d.supplier_address ?? '',
    });
    if (detail) {
      const d = detail.document;
      setDocDate(d.doc_date);
      setSupplierText(d.supplier_name ?? '');
      setSupplierId(d.supplier_id);
      setPhone(manual(d).phone);
      setEmail(manual(d).email);
      setAddress(manual(d).address);
      setTitle(d.title);
      setDueDate(d.due_date ?? (d.doc_type === 'rfq' ? plusDays(today, 14) : ''));
      setNotes(d.notes);
      setLines(linesFromRows(detail.lines));
      setParties(d.doc_type === 'rfq' ? partiesOfDetail(detail) : []);
      // The ticks belong to a draft; an issued request has already been sent (or not).
      setSendEmail(d.status === 'draft' && d.send_email);
      setSendWhatsapp(d.status === 'draft' && d.send_whatsapp);
    } else if (prefill) {
      const s = suppliers.find((x) => x.id === prefill.supplier_id);
      setDocDate(today);
      setSupplierText(prefill.manual?.name ?? s?.name ?? '');
      setSupplierId(prefill.supplier_id);
      setPhone(prefill.manual?.phone ?? ''); setEmail(prefill.manual?.email ?? ''); setAddress(prefill.manual?.address ?? '');
      setTitle(prefill.title);
      setDueDate('');
      setNotes('');
      setLines(linesFromRows(prefill.lines));
      setParties([]); setSendEmail(false); setSendWhatsapp(false);
    } else {
      setDocDate(today);
      setSupplierText(''); setSupplierId(null);
      setPhone(''); setEmail(''); setAddress('');
      setTitle('');
      setDueDate(plusDays(today, 14));
      setNotes('');
      setLines([emptyLine()]);
      setParties([]); setSendEmail(false); setSendWhatsapp(false);
    }
    // The number shown in the heading is the one the server would give NOW.
    if (!detail || detail.document.status === 'draft') {
      fetch('/api/purchasing/company', { credentials: 'include' })
        .then((r) => r.json())
        .then((b) => { if (b.sequences) setLiveSeq(b.sequences); })
        .catch(() => undefined);
    }
  }, [open, detail, prefill, today, suppliers, sequences]);

  const needsStart = !editing && liveSeq[type] === null;
  const startValue = Number(startNumber);
  const nextNumber = editing ? detail?.document.number : needsStart ? (Number.isInteger(startValue) && startValue >= 1 ? startValue : null) : (liveSeq[type] ?? 0) + 1;
  // A request needs its subject — except an issued one that never had it (it
  // predates the rule and stays editable while its subject stays empty).
  const titleRequired = isRfq && !(editing && (detail?.document.title ?? '') === '');
  const errors = {
    title: touched && titleRequired && !title.trim() ? 'יש להזין נושא לבקשה' : null,
    date: touched && !docDate ? 'יש לבחור תאריך מסמך' : null,
    supplier: touched && !isRfq && !supplierText.trim() ? 'יש לבחור ספק או להקליד שם ספק' : null,
    suppliers: touched && isRfq && !editing && parties.length === 0 ? 'יש לבחור ספק אחד לפחות' : null,
    due: touched && isRfq && !dueDate ? 'יש לבחור תאריך יעד' : null,
    start: touched && needsStart && (!Number.isInteger(startValue) || startValue < 1) ? 'יש להזין מספר שלם מ-1 ומעלה' : null,
    email: touched && !isRfq && !supplierId && email.trim() && !EMAIL_RE.test(email.trim()) ? 'כתובת מייל לא תקינה' : null,
  };
  const partyEmailBad = isRfq && !editing && parties.some((p) => !p.supplierId && p.email.trim() && !EMAIL_RE.test(p.email.trim()));
  const linesLocked = isRfq && editing && !!detail?.lines_locked;
  const busy = saving || previewing;

  // The results screen of an issued request sits on top of this sheet and owns Escape.
  useEscapeKey(open && !issued, () => requestClose());
  function requestClose() { if (!busy && !issued) onOpenChange(false); }

  /** The API body of the form, or null (with the problems shown) when invalid. */
  function buildBody(): Record<string, unknown> | null {
    setTouched(true);
    setLineError(null);
    if (!docDate || (!isRfq && !supplierText.trim()) || (isRfq && !dueDate) || (titleRequired && !title.trim())) return null;
    if (isRfq && parties.length === 0) return null;
    if (needsStart && (!Number.isInteger(startValue) || startValue < 1)) return null;
    if (!isRfq && !supplierId && email.trim() && !EMAIL_RE.test(email.trim())) return null;
    if (partyEmailBad) return null;
    const payload = draftsToPayload(lines, !isRfq);
    if (!payload.ok) { setLineError({ key: payload.key, message: payload.error }); return null; }

    return {
      doc_date: docDate,
      title: title.trim(),
      notes: notes.trim(),
      ...(isRfq ? requestBody() : supplierBody()),
      ...(isRfq ? { due_date: dueDate } : {}),
      lines: payload.lines,
    };
  }

  async function preview() {
    const base = buildBody();
    if (!base) return;
    // Opened synchronously so the popup blocker lets it through; filled below.
    const win = window.open('', '_blank');
    setPreviewing(true);
    try {
      const qs = editing && detail ? `?number=${detail.document.number}` : '';
      const res = await fetch(`/api/purchasing/preview${qs}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ doc_type: type, start_number: needsStart ? startValue : null, ...base }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        win?.close();
        if (body.error === 'company_missing') { onNeedCompany(); return; }
        toast.error(typeof body.error === 'string' ? body.error : 'התצוגה המקדימה נכשלה');
        return;
      }
      const url = URL.createObjectURL(await res.blob());
      if (win) win.location.href = url;
      else window.open(url, '_blank');
      setTimeout(() => URL.revokeObjectURL(url), 5 * 60 * 1000);
    } catch {
      win?.close();
      toast.error('התצוגה המקדימה נכשלה');
    } finally {
      setPreviewing(false);
    }
  }

  /** A request's suppliers (any number) and its "send by" ticks. */
  function requestBody() {
    return { recipients: recipientsPayload(parties), send_email: sendEmail, send_whatsapp: sendWhatsapp };
  }

  /** The supplier columns of the form: a name typed exactly like a listed
   *  supplier IS that supplier. */
  function supplierBody() {
    const typed = supplierText.trim();
    const linked = supplierId ?? (typed ? suppliers.find((s) => s.name.trim().toLowerCase() === typed.toLowerCase())?.id : null) ?? null;
    return {
      supplier_id: linked,
      supplier_name: linked ? '' : typed,
      supplier_phone: linked ? '' : phone.trim(),
      supplier_email: linked ? '' : email.trim(),
      supplier_address: linked ? '' : address.trim(),
    };
  }

  /** Saves the form as a DRAFT on the server: lenient (nothing is required but
   *  something to save), no number is taken. */
  async function saveDraft() {
    setLineError(null);
    if (titleRequired && !title.trim()) { setTouched(true); return; }
    const payload = draftsToPayload(lines, false, true);
    if (!payload.ok) { setLineError({ key: payload.key, message: payload.error }); return; }
    if (partyEmailBad) { setTouched(true); return; }
    if (!supplierText.trim() && parties.length === 0 && !title.trim() && payload.lines.length === 0) {
      toast.error('אין מה לשמור בטיוטה — מלאו ספק, תיאור או שורה');
      return;
    }
    setSaving(true);
    try {
      const body = {
        doc_type: type, doc_date: docDate || today, title: title.trim(), notes: notes.trim(),
        ...(isRfq ? requestBody() : supplierBody()), due_date: isRfq ? dueDate || null : null, lines: payload.lines,
        ...(isRfq ? {} : { source_rfq_id: prefill?.source_rfq_id ?? null }),
      };
      const res = draft
        ? await fetch(`/api/purchasing/documents/${draft.id}?mode=draft`, {
            method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
          })
        : await fetch('/api/purchasing/documents?mode=draft', {
            method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
          });
      const out = await res.json().catch(() => ({}));
      if (!res.ok) { toast.error(typeof out.error === 'string' ? out.error : 'שמירת הטיוטה נכשלה'); return; }
      toast.success('הטיוטה נשמרה');
      onOpenChange(false);
      onSaved(draft ? draft.id : out.id, false);
    } catch {
      toast.error('שמירת הטיוטה נכשלה');
    } finally {
      setSaving(false);
    }
  }

  /** After a request was issued: send it over the ticked channels, then show the
   *  outcome (or, with nothing ticked, the per-supplier PDF / print list). */
  async function finishRequest(id: string, number: number) {
    const sending = sendEmail || sendWhatsapp;
    let results: IssueResult[] | null = null;
    let sendError: string | null = null;
    if (sending) {
      try {
        const res = await fetch(`/api/purchasing/documents/${id}/send`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ supplier_ids: parties.map((p) => p.key), email: sendEmail, whatsapp: sendWhatsapp }),
        });
        const out = await res.json().catch(() => ({}));
        if (Array.isArray(out.results)) results = out.results as IssueResult[];
        else sendError = typeof out.error === 'string' ? out.error : 'השליחה נכשלה';
      } catch {
        sendError = 'השליחה נכשלה';
      }
    }
    setIssued({
      id, heading: docHeading('rfq', number), results, sendError,
      parties: parties.map((p) => ({ key: p.key, name: p.name })),
    });
    // The list behind the form already shows the new request.
    onSaved(id, false);
  }

  function closeResults() {
    const info = issued;
    setIssued(null);
    onOpenChange(false);
    if (info) onSaved(info.id, true);
  }

  async function save() {
    const base = buildBody();
    if (!base) return;
    setSaving(true);
    try {
      let res: Response;
      if (editing && detail) {
        res = await fetch(`/api/purchasing/documents/${detail.document.id}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ ...base, due_date: isRfq ? dueDate : null, ...(linesLocked ? { lines: undefined } : {}) }),
        });
      } else if (draft) {
        // Issuing a draft: the running number is allocated now.
        res = await fetch(`/api/purchasing/documents/${draft.id}?mode=issue`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ doc_type: type, start_number: needsStart ? startValue : null, ...base }),
        });
      } else {
        res = await fetch('/api/purchasing/documents', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            doc_type: type, start_number: needsStart ? startValue : null, ...base,
            ...(isRfq ? {} : { source_rfq_id: prefill?.source_rfq_id ?? null }),
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
      const id: string = detail ? detail.document.id : body.id;
      if (!editing && nextNumber !== null && body.number !== nextNumber) {
        toast.info(`המספר ${nextNumber} נתפס בינתיים — המסמך הופק כמספר ${body.number}`);
      } else {
        toast.success(editing ? 'המסמך עודכן' : `${DOC_LABEL[type]} מספר ${body.number} הופקה`);
      }
      // A request is sent in the same step (the ticks), then its outcome is shown.
      if (isRfq && !editing) {
        await finishRequest(id, body.number ?? nextNumber ?? 0);
        return;
      }
      onOpenChange(false);
      onSaved(id, true);
    } catch {
      toast.error('השמירה נכשלה');
    } finally {
      setSaving(false);
    }
  }

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
              <SheetTitle className="flex flex-wrap items-center gap-x-2 gap-y-2 text-2xl font-bold text-white" data-form-heading>
                <span>{DOC_LABEL[type]} מספר</span>
                {needsStart ? (
                  <Input
                    id="doc-start" value={startNumber} dir="ltr" inputMode="numeric" disabled={busy}
                    onChange={(e) => setStartNumber(e.target.value)} aria-label="מאיזה מספר להתחיל"
                    aria-invalid={errors.start ? true : undefined} placeholder="מספר התחלתי"
                    className="h-10 w-40 border-white/30 bg-white/10 text-center text-lg font-bold tabular-nums text-white placeholder:text-white/50"
                  />
                ) : (
                  <span className="tabular-nums" data-doc-number>{nextNumber}</span>
                )}
              </SheetTitle>
              <p className="mt-1 truncate text-sm text-white/70">
                {[
                  needsStart ? (errors.start ?? `זה ${DOC_LABEL[type]} הראשונה — מכאן המספר רץ אוטומטית`) : '',
                  draft ? 'טיוטה שמורה — המספר יוקצה בהפקה' : '',
                  prefill ? `מבקשה מספר ${prefill.source_rfq_number}` : '',
                ].filter(Boolean).join(' · ')}
              </p>
            </div>
            <button
              type="button"
              onClick={requestClose}
              aria-label="סגור"
              disabled={busy}
              className="flex h-11 w-11 shrink-0 items-center justify-center rounded-lg border border-white/25 bg-white/5 text-white transition-colors hover:border-white/50 hover:bg-white/15 disabled:opacity-60"
            >
              <X className="h-5 w-5" />
            </button>
          </div>
        </SheetHeader>

        <div className="flex-1 space-y-5 overflow-y-auto bg-slate-50/60 p-5">
          <Section title="פרטי המסמך" icon={Hash} iconTone="blue">
            <div className="grid gap-4 py-2 sm:grid-cols-2">
              <div className="space-y-2">
                <Label htmlFor="doc-date" className="text-base font-medium text-muted-foreground">
                  תאריך מסמך<span className="text-red-500"> *</span>
                </Label>
                <input
                  id="doc-date" type="date" value={docDate} onChange={(e) => setDocDate(e.target.value)}
                  onClick={openPicker} disabled={busy} aria-invalid={errors.date ? true : undefined}
                  className={dateInputClass(!!errors.date)}
                />
                {errors.date && <p className="text-[12px] font-semibold text-red-500 text-start">⚠️ {errors.date}</p>}
              </div>

              {isRfq && (
                <div className="space-y-2">
                  <Label htmlFor="doc-due" className="text-base font-medium text-muted-foreground">
                    תאריך יעד להגשה<span className="text-red-500"> *</span>
                  </Label>
                  <input
                    id="doc-due" type="date" value={dueDate} min={editing ? undefined : today}
                    onChange={(e) => setDueDate(e.target.value)} onClick={openPicker} disabled={busy}
                    aria-invalid={errors.due ? true : undefined} className={dateInputClass(!!errors.due)}
                  />
                  {errors.due
                    ? <p className="text-[12px] font-semibold text-red-500 text-start">⚠️ {errors.due}</p>
                    : <p className="text-[12px] text-slate-500">עד תאריך זה הספק יכול להגיש ולתקן הצעה; אחריו הקישור נעול לקריאה.</p>}
                </div>
              )}

              {isRfq ? (
                <div className="sm:col-span-2">
                  <RecipientsField
                    parties={parties} onParties={setParties} suppliers={suppliers}
                    sendEmail={sendEmail} sendWhatsapp={sendWhatsapp}
                    onSendEmail={setSendEmail} onSendWhatsapp={setSendWhatsapp}
                    readOnly={editing} error={errors.suppliers} touched={touched} disabled={busy}
                  />
                </div>
              ) : (
                <div className="sm:col-span-2">
                  <SupplierField
                    id="doc-supplier" text={supplierText} supplierId={supplierId} suppliers={suppliers}
                    onChange={(n) => { setSupplierText(n.text); setSupplierId(n.supplierId); }}
                    error={errors.supplier} disabled={busy}
                  />
                </div>
              )}
              {!isRfq && !supplierId && supplierText.trim() && (
                <>
                  <Field id="doc-supplier-phone" label="טלפון" value={phone} onChange={setPhone} dir="ltr" inputMode="tel" disabled={busy} />
                  <Field id="doc-supplier-email" label="מייל" value={email} onChange={setEmail} dir="ltr" type="email" error={errors.email} disabled={busy} />
                  <div className="sm:col-span-2">
                    <Field id="doc-supplier-address" label="כתובת" value={address} onChange={setAddress} disabled={busy} />
                  </div>
                </>
              )}

              <div className="sm:col-span-2">
                <Field
                  id="doc-title" label={isRfq ? 'נושא' : 'תיאור'} required={titleRequired} value={title}
                  onChange={(v) => setTitle(v.slice(0, PURCHASING_LIMITS.titleMax))} error={errors.title} disabled={busy}
                />
              </div>
            </div>
          </Section>

          <Section title="פירוטים" icon={ListChecks} iconTone="emerald">
            <div className="space-y-3 py-2">
              {linesLocked && (
                <p className="rounded-md border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">
                  הבקשה כבר נשלחה לספקים — השורות נעולות, כי ההצעות מתומחרות לפיהן.
                </p>
              )}
              <LinesEditor
                lines={lines} onChange={setLines} vatRate={vatRate}
                disabled={busy || linesLocked} errorKey={lineError?.key ?? null}
              />
              {lineError && <p className="text-[12px] font-semibold text-red-500 text-start">⚠️ {lineError.message}</p>}
            </div>
          </Section>

          <Section title="הערות" icon={StickyNote} iconTone="amber">
            <div className="space-y-2 py-2">
              <Textarea
                id="doc-notes" value={notes} rows={4} disabled={busy}
                onChange={(e) => setNotes(e.target.value.slice(0, PURCHASING_LIMITS.notesMax))}
              />
              <p className="text-[12px] text-slate-500">מודפס בתחתית המסמך.</p>
            </div>
          </Section>
        </div>

        <footer className="flex-none border-t border-slate-200 bg-white px-5 py-3 pb-[max(0.75rem,env(safe-area-inset-bottom))]">
          <div className="flex flex-col-reverse gap-2 sm:flex-row sm:items-center sm:justify-between sm:gap-3">
            <div className="flex flex-wrap items-center gap-2">
              <Button type="button" variant="outline" onClick={requestClose} disabled={busy} className="h-11 flex-1 sm:flex-none">
                ביטול
              </Button>
              {!editing && (
                <Button type="button" variant="outline" onClick={saveDraft} disabled={busy} className="h-11 flex-1 gap-2 sm:flex-none">
                  <Save className="h-4 w-4" /> שמור טיוטה
                </Button>
              )}
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <Button type="button" variant="outline" onClick={preview} disabled={busy} className="h-11 flex-1 gap-2 sm:flex-none">
                {previewing ? <Loader2 className="h-4 w-4 animate-spin" /> : <Eye className="h-4 w-4" />} תצוגה מקדימה
              </Button>
              <Button type="button" onClick={save} disabled={busy} className="h-11 flex-1 gap-2 sm:flex-none">
                <FilePlus2 className="h-4 w-4" />
                {saving ? 'שומר…' : editing ? 'שמור שינויים' : 'הפק את המסמך'}
              </Button>
            </div>
          </div>
        </footer>
      </SheetContent>
    </Sheet>
    <IssueResultsSheet info={issued} onClose={closeResults} />
    </>
  );
}
