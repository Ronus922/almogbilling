'use client';

// The "ספקים וסטטוס" card of a request's document tab: one block per supplier — name, the three
// steps with their time (sent → opened → submitted), the quote's amount before VAT and a link to
// the comparison; below, the quote's validity, its attachments, the personal link, the supplier's
// own PDF, a resend and (staff) delete-quote. "הוסף ספק" expands the picker INLINE in the card
// (never a window) to add suppliers to an issued request that is still open.

import { useMemo, useState } from 'react';
import { toast } from 'sonner';
import { Award, Copy, Download, ExternalLink, Loader2, Paperclip, Send, ShoppingCart, Trash2, UserPlus, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Section } from '@/components/side-panel/Section';
import {
  comparisonOf, formatDocDate, formatIls, formatStampShortIL, isRfqOpen, partyKey,
} from '@/lib/purchasing/model';
import { RecipientsField } from './RecipientsField';
import { EMAIL_RE, recipientsPayload, type PartyDraft } from './recipients';
import { downloadPdf } from './pdfActions';
import { summarizeSend, type SendResult } from './sendOutcome';
import type { DocumentDetail, QuoteView, RecipientView, SupplierBrief } from './types';

interface Props {
  detail: DocumentDetail;
  suppliers: SupplierBrief[];
  canEdit: boolean;
  onChanged: () => void;
  /** The "להשוואה" link: switches the window to the comparison tab. */
  onShowComparison: () => void;
}

interface Row {
  key: string;
  name: string;
  recipient: RecipientView | null;
  quote: QuoteView | null;
}

const PILL = 'rounded-full border px-2.5 py-0.5 text-xs font-semibold tabular-nums';
const ICON_BTN = 'grid h-11 w-11 shrink-0 place-items-center rounded-lg text-ink-3 transition-colors hover:bg-slate-100 disabled:pointer-events-none disabled:opacity-40';

const money = (n: number) => formatIls(n).replace(/\.00$/, '');

export function SuppliersCard({ detail, suppliers, canEdit, onChanged, onShowComparison }: Props) {
  const doc = detail.document;
  const quotes = useMemo(() => detail.quotes ?? [], [detail.quotes]);
  const recipients = useMemo(() => detail.recipients ?? [], [detail.recipients]);
  const [busy, setBusy] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [parties, setParties] = useState<PartyDraft[]>([]);
  const [sendEmail, setSendEmail] = useState(doc.send_email);
  const [sendWhatsapp, setSendWhatsapp] = useState(doc.send_whatsapp);
  const [touched, setTouched] = useState(false);
  const [pickError, setPickError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const open = doc.status === 'issued' && !!doc.due_date && isRfqOpen(doc.due_date);
  const winnerKey = doc.winner_chosen_at ? (doc.winner_manual ? doc.winner_manual_key : doc.winner_supplier_id) : null;
  const cols = useMemo(() => comparisonOf(detail.lines, quotes), [detail.lines, quotes]);

  const rows: Row[] = useMemo(() => [
    ...recipients.map((r) => ({
      key: partyKey(r), name: r.supplier_name, recipient: r, quote: quotes.find((q) => partyKey(q) === partyKey(r)) ?? null,
    })),
    ...quotes
      .filter((q) => !recipients.some((r) => partyKey(r) === partyKey(q)))
      .map((q) => ({ key: partyKey(q), name: q.supplier_name, recipient: null, quote: q })),
  ], [recipients, quotes]);

  const taken = useMemo(() => new Set(rows.map((r) => r.key)), [rows]);
  const available = useMemo(() => suppliers.filter((s) => !taken.has(s.id)), [suppliers, taken]);

  async function copyLink(link: string) {
    try {
      await navigator.clipboard.writeText(link);
      toast.success('הקישור הועתק');
    } catch {
      toast.error('ההעתקה נכשלה');
    }
  }

  async function removeQuote(r: Row) {
    if (!r.quote || !window.confirm(`למחוק את ההצעה של ${r.name}?`)) return;
    setBusy(`del:${r.key}`);
    try {
      const res = await fetch(`/api/purchasing/documents/${doc.id}/quotes?supplier_id=${r.key}`, { method: 'DELETE' });
      if (!res.ok) throw new Error('delete failed');
      onChanged();
    } catch {
      toast.error('המחיקה נכשלה');
    } finally {
      setBusy(null);
    }
  }

  async function postSend(keys: string[], email: boolean, whatsapp: boolean): Promise<SendResult[]> {
    const res = await fetch(`/api/purchasing/documents/${doc.id}/send`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ supplier_ids: keys, email, whatsapp }),
    });
    const out = await res.json().catch(() => ({})) as { results?: SendResult[]; error?: string };
    if (!res.ok || !out.results) throw new Error(out.error ?? 'send failed');
    return out.results;
  }

  function toastResults(results: SendResult[]) {
    const s = summarizeSend(results);
    if (s.level === 'success') toast.success(s.message);
    else if (s.level === 'warning') toast.warning(s.message);
    else toast.error(s.message);
  }

  /** Re-send over the channels ticked on the document; none ticked → whatever the supplier can be reached by. */
  async function resend(r: Row) {
    if (!r.recipient) return;
    const listed = r.recipient.supplier_id ? suppliers.find((s) => s.id === r.recipient!.supplier_id) : null;
    const email = (listed ? listed.email : r.recipient.supplier_email ?? '').trim();
    const phone = (listed ? listed.mobile || listed.phone : r.recipient.supplier_phone ?? '').trim();
    let useEmail = doc.send_email;
    let useWhatsapp = doc.send_whatsapp;
    if (!useEmail && !useWhatsapp) {
      if (email) useEmail = true;
      else if (phone) useWhatsapp = true;
      else {
        toast.error(`ל${r.name} אין מייל או טלפון — אי אפשר לשלוח`);
        return;
      }
    }
    setBusy(`send:${r.key}`);
    try {
      toastResults(await postSend([r.key], useEmail, useWhatsapp));
      onChanged();
    } catch (err) {
      toast.error(err instanceof Error && err.message !== 'send failed' ? err.message : 'השליחה נכשלה');
    } finally {
      setBusy(null);
    }
  }

  function closePanel() {
    setAdding(false);
    setParties([]);
    setTouched(false);
    setPickError(null);
  }

  async function submitAdd() {
    setTouched(true);
    if (parties.length === 0) { setPickError('יש לבחור ספק אחד לפחות'); return; }
    const present = new Set(rows.map((r) => r.name.trim().toLowerCase()));
    if (parties.some((p) => !p.supplierId && present.has(p.name.trim().toLowerCase()))) {
      setPickError('ספק בשם הזה כבר ברשימת הבקשה');
      return;
    }
    setPickError(null);
    if (parties.some((p) => !p.supplierId && p.email.trim() && !EMAIL_RE.test(p.email.trim()))) return;
    setSaving(true);
    try {
      const add = await fetch(`/api/purchasing/documents/${doc.id}/recipients`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ recipients: recipientsPayload(parties) }),
      });
      const added = await add.json().catch(() => ({})) as { added_keys?: string[]; error?: string };
      if (!add.ok || !added.added_keys) throw new Error(added.error ?? 'הוספת הספקים נכשלה');
      if (added.added_keys.length === 0) {
        toast.info('הספקים כבר ברשימה');
      } else if (!sendEmail && !sendWhatsapp) {
        toast.success('הספקים נוספו - אפשר להוריד או להדפיס PDF לכל ספק');
      } else {
        try {
          toastResults(await postSend(added.added_keys, sendEmail, sendWhatsapp));
        } catch (err) {
          toast.error(`הספקים נוספו, אך השליחה נכשלה${err instanceof Error && err.message !== 'send failed' ? `: ${err.message}` : ''}`);
        }
      }
      closePanel();
      onChanged();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'הוספת הספקים נכשלה');
    } finally {
      setSaving(false);
    }
  }

  const showAdd = canEdit && doc.status === 'issued';

  return (
    <div data-suppliers-card>
      <Section
        title="ספקים וסטטוס" icon={ShoppingCart} iconTone="violet"
        headerSlot={(
          <>
            <span className="hidden text-xs font-medium text-slate-400 sm:inline">תוכן ההצעות מוצג בלשונית השוואת הצעות</span>
            {showAdd && !adding && (
              <button
                type="button" disabled={!open} onClick={() => setAdding(true)} data-action="add-supplier"
                title={open ? undefined : 'הבקשה נעולה'}
                className="inline-flex h-11 items-center gap-2 rounded-lg border border-line bg-white px-4 text-sm font-semibold text-ink-2 transition-colors hover:bg-slate-50 disabled:pointer-events-none disabled:opacity-50"
              >
                <UserPlus className="h-4 w-4" aria-hidden /> הוסף ספק
              </button>
            )}
          </>
        )}
      >
        <div className="space-y-3 py-2" data-recipients>
          {adding && (
            <div className="space-y-4 rounded-xl border border-blue-200 bg-blue-50/40 p-4" data-add-suppliers-panel>
              <RecipientsField
                parties={parties} onParties={(p) => { setParties(p); setPickError(null); }}
                sendEmail={sendEmail} sendWhatsapp={sendWhatsapp}
                onSendEmail={setSendEmail} onSendWhatsapp={setSendWhatsapp}
                suppliers={available} error={pickError} touched={touched} disabled={saving}
              />
              <div className="flex flex-wrap items-center gap-2">
                <Button type="button" onClick={submitAdd} disabled={saving} className="h-11 gap-2 px-4" data-action="add-suppliers-send">
                  {saving ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : <Send className="h-4 w-4" aria-hidden />} שלח
                </Button>
                <Button type="button" variant="outline" onClick={closePanel} disabled={saving} className="h-11 gap-2 px-4" data-action="add-suppliers-cancel">
                  <X className="h-4 w-4" aria-hidden /> ביטול
                </Button>
              </div>
            </div>
          )}

          {rows.length === 0 && (
            <p className="rounded-lg border border-line bg-white p-4 text-center text-sm text-ink-3">לבקשה זו לא נבחרו ספקים.</p>
          )}

          {rows.map((r) => {
            const col = r.quote ? cols.find((c) => c.supplier_id === r.key) : null;
            return (
              <div key={r.key} className="rounded-xl border border-line bg-white p-4" data-recipient={r.key}>
                <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
                  <span className="text-base font-bold text-ink">{r.name}</span>
                  <span className="flex flex-wrap items-center gap-1.5" data-recipient-status>
                    {r.recipient?.sent_at && (
                      <span className={`${PILL} border-slate-200 bg-slate-100 text-slate-600`}>נשלח {formatStampShortIL(r.recipient.sent_at)}</span>
                    )}
                    {r.recipient?.first_viewed_at ? (
                      <span className={`${PILL} border-amber-200 bg-amber-50 text-amber-700`}>נצפה {formatStampShortIL(r.recipient.first_viewed_at)}</span>
                    ) : r.recipient?.sent_at ? (
                      <span className={`${PILL} border-slate-200 bg-slate-100 text-slate-600`}>טרם נצפה</span>
                    ) : null}
                    {r.quote && (
                      <span className={`${PILL} border-emerald-200 bg-emerald-50 text-emerald-700`}>הגיש {formatStampShortIL(r.quote.updated_at)}</span>
                    )}
                  </span>
                  {winnerKey === r.key && (
                    <span className="inline-flex items-center gap-1 rounded-full bg-violet-100 px-2.5 py-0.5 text-xs font-bold text-violet-700">
                      <Award className="h-3 w-3" aria-hidden /> זוכה
                    </span>
                  )}
                  {r.quote && (
                    <span className="ms-auto flex items-center gap-4">
                      {col?.total != null && (
                        <span className="text-lg font-bold tabular-nums text-ink" dir="ltr" data-quote-amount>{money(col.total)}</span>
                      )}
                      <button
                        type="button" onClick={onShowComparison} data-action="to-comparison"
                        className="inline-flex min-h-11 items-center gap-1.5 text-sm font-semibold text-brand hover:underline"
                      >
                        <ExternalLink className="h-4 w-4" aria-hidden /> להשוואה
                      </button>
                    </span>
                  )}
                </div>

                <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1 border-t border-line pt-3 text-sm">
                  {r.quote?.valid_until && (
                    <span className="text-ink-3">תוקף ההצעה: <span className="font-semibold tabular-nums text-ink-2">{formatDocDate(r.quote.valid_until)}</span></span>
                  )}
                  {r.quote?.files.map((f) => (
                    <a key={f.id} href={f.url} target="_blank" rel="noopener noreferrer"
                      className="inline-flex min-h-11 items-center gap-1.5 font-semibold text-brand hover:underline">
                      <Paperclip className="h-4 w-4" aria-hidden /> {f.original_filename}
                    </a>
                  ))}
                  {r.quote?.notes && <span className="w-full whitespace-pre-wrap text-xs text-ink-2">הערות: {r.quote.notes}</span>}
                  <span className="ms-auto flex flex-wrap items-center gap-1">
                    {doc.status === 'issued' && (
                      <button type="button" onClick={() => downloadPdf(doc.id, r.key)} title="הורדת PDF לספק" aria-label={`הורדת PDF עבור ${r.name}`}
                        data-action="supplier-pdf" className={ICON_BTN}>
                        <Download className="h-4 w-4" />
                      </button>
                    )}
                    {r.recipient && canEdit && (
                      <button type="button" disabled={!open || busy === `send:${r.key}`} onClick={() => resend(r)}
                        title={open ? 'שליחה חוזרת' : 'הבקשה נעולה'} aria-label={`שליחה חוזרת ל${r.name}`} data-action="supplier-resend" className={ICON_BTN}>
                        {busy === `send:${r.key}` ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
                      </button>
                    )}
                    {r.recipient && (
                      <button type="button" onClick={() => copyLink(r.recipient!.link)} title="העתקת הקישור האישי" aria-label={`העתקת הקישור של ${r.name}`}
                        data-action="copy-link"
                        className="inline-flex h-11 items-center gap-1.5 rounded-lg px-3 text-sm font-semibold text-ink-2 hover:bg-slate-100">
                        <Copy className="h-4 w-4" aria-hidden /> קישור
                      </button>
                    )}
                    {canEdit && r.quote && (
                      <button type="button" disabled={busy === `del:${r.key}`} onClick={() => removeQuote(r)} aria-label={`מחיקת ההצעה של ${r.name}`}
                        className={`${ICON_BTN} hover:bg-rose-50 hover:text-rose-600`}>
                        <Trash2 className="h-4 w-4" />
                      </button>
                    )}
                  </span>
                </div>
              </div>
            );
          })}
        </div>
      </Section>
    </div>
  );
}
