'use client';

// The read view of one document (DESIGN §12 — a side panel): its details,
// lines and totals, files, the send log and — for a request — the suppliers,
// quotes, comparison and winner. Actions: PDF (view / download), send, edit,
// delete. Everything is fetched from /api/purchasing/documents/[id] on open.

import { useCallback, useEffect, useState } from 'react';
import { toast } from 'sonner';
import { Download, Eye, FileText, Hash, History, ListChecks, Loader2, Paperclip, Pencil, Send, Trash2, X } from 'lucide-react';
import { Sheet, SheetContent, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { Button } from '@/components/ui/button';
import { Section } from '@/components/side-panel/Section';
import { formatFileSize } from '@/lib/decisions';
import {
  computeTotals, docHeading, formatDocDate, formatIls, formatQty, formatStampIL, formatVatRate, isRfqOpen, lineTotal,
} from '@/lib/purchasing/model';
import { QuotesSection } from './QuotesSection';
import { SendSheet } from './SendSheet';
import type { DocumentDetail, PoPrefill, SupplierBrief } from './types';

interface Props {
  documentId: string | null;
  canEdit: boolean;
  suppliers: SupplierBrief[];
  /** Bumped by the parent after any save so an open panel re-reads. */
  refreshKey: number;
  onClose: () => void;
  onEdit: (detail: DocumentDetail) => void;
  onCreatePo: (prefill: PoPrefill) => void;
  /** The list behind the panel changed (send, quote, winner, delete). */
  onChanged: () => void;
}

export function DocumentDetailSheet({ documentId, canEdit, suppliers, refreshKey, onClose, onEdit, onCreatePo, onChanged }: Props) {
  const [detail, setDetail] = useState<DocumentDetail | null>(null);
  const [loading, setLoading] = useState(false);
  const [sendOpen, setSendOpen] = useState(false);
  const [deleting, setDeleting] = useState(false);

  const load = useCallback(async (id: string) => {
    try {
      const res = await fetch(`/api/purchasing/documents/${id}`, { credentials: 'include' });
      if (!res.ok) throw new Error('load failed');
      setDetail(await res.json());
    } catch {
      toast.error('טעינת המסמך נכשלה');
    }
  }, []);

  useEffect(() => {
    if (!documentId) { setDetail(null); return; }
    setLoading(true);
    load(documentId).finally(() => setLoading(false));
  }, [documentId, refreshKey, load]);

  const reload = () => { if (documentId) void load(documentId); onChanged(); };

  async function remove() {
    if (!detail) return;
    const d = detail.document;
    if (!window.confirm(`למחוק את ${docHeading(d.doc_type, d.number)}? המספר לא ישוחזר ולא ייעשה בו שימוש שוב.`)) return;
    setDeleting(true);
    try {
      const res = await fetch(`/api/purchasing/documents/${d.id}`, { method: 'DELETE' });
      if (!res.ok) throw new Error('delete failed');
      toast.success('המסמך נמחק');
      onChanged();
      onClose();
    } catch {
      toast.error('המחיקה נכשלה');
    } finally {
      setDeleting(false);
    }
  }

  const doc = detail?.document;
  const isRfq = doc?.doc_type === 'rfq';
  const priced = !!detail && (!isRfq || detail.lines.some((l) => l.unit_price !== null));
  const totals = detail && doc && priced ? computeTotals(detail.lines, doc.vat_rate) : null;
  const pdfUrl = doc ? `/api/purchasing/documents/${doc.id}/pdf` : '';

  return (
    <>
      {/* While a child sheet (send) is open, Escape and the backdrop
          belong to IT — closing both at once would drop the user out of the document. */}
      <Sheet open={!!documentId} onOpenChange={(o) => { if (!o && !sendOpen) onClose(); }}>
        <SheetContent
          side="left" dir="rtl" showCloseButton={false}
          className="w-full max-w-full p-0 sm:w-[92vw] md:w-[80vw] lg:w-[55vw] lg:min-w-[720px] flex flex-col gap-0 overflow-hidden bg-white"
        >
          <SheetHeader className="flex-none gap-2 bg-gradient-to-bl from-slate-900 via-blue-950 to-blue-900 px-6 py-6 text-white">
            <div className="flex items-start justify-between gap-4">
              <div className="min-w-0 flex-1">
                <SheetTitle className="text-2xl font-bold text-white">
                  {doc ? docHeading(doc.doc_type, doc.number) : 'טוען…'}
                </SheetTitle>
                <p className="mt-1 truncate text-sm text-white/70">
                  {doc ? [doc.title, doc.supplier_name].filter(Boolean).join(' · ') : ''}
                </p>
              </div>
              <button
                type="button" onClick={onClose} aria-label="סגור"
                className="flex h-11 w-11 shrink-0 items-center justify-center rounded-lg border border-white/25 bg-white/5 text-white transition-colors hover:border-white/50 hover:bg-white/15"
              >
                <X className="h-5 w-5" />
              </button>
            </div>
          </SheetHeader>

          <div className="flex-1 space-y-5 overflow-y-auto bg-slate-50/60 p-5">
            {(loading && !detail) && (
              <div className="grid place-items-center p-12 text-ink-3"><Loader2 className="h-6 w-6 animate-spin" aria-label="טוען" /></div>
            )}

            {detail && doc && (
              <>
                <div className="flex flex-wrap gap-2" data-pdf-actions>
                  <a href={pdfUrl} target="_blank" rel="noopener noreferrer"
                    className="inline-flex h-11 items-center gap-2 rounded-lg border border-line bg-white px-4 text-sm font-semibold text-ink-2 hover:bg-slate-50">
                    <Eye className="h-4 w-4" /> צפייה ב-PDF
                  </a>
                  <a href={`${pdfUrl}?download=1`}
                    className="inline-flex h-11 items-center gap-2 rounded-lg border border-line bg-white px-4 text-sm font-semibold text-ink-2 hover:bg-slate-50">
                    <Download className="h-4 w-4" /> הורדת PDF
                  </a>
                </div>

                <Section title="פרטי המסמך" icon={Hash} iconTone="blue">
                  <dl className="grid gap-x-6 gap-y-3 py-2 text-sm sm:grid-cols-2" data-doc-details>
                    <div><dt className="text-ink-3">מספר</dt><dd className="font-semibold tabular-nums text-ink">{doc.number}</dd></div>
                    <div><dt className="text-ink-3">תאריך</dt><dd className="font-semibold tabular-nums text-ink">{formatDocDate(doc.doc_date)}</dd></div>
                    <div><dt className="text-ink-3">ספק</dt><dd className="font-semibold text-ink">{doc.supplier_name}</dd></div>
                    {!doc.supplier_id && (doc.supplier_phone || doc.supplier_email || doc.supplier_address) && (
                      <div>
                        <dt className="text-ink-3">פרטי הספק</dt>
                        <dd className="text-ink">{[doc.supplier_phone, doc.supplier_email, doc.supplier_address].filter(Boolean).join(' · ')}</dd>
                      </div>
                    )}
                    {isRfq && (
                      <div>
                        <dt className="text-ink-3">תאריך יעד להגשה</dt>
                        <dd className="font-semibold tabular-nums text-ink">
                          {formatDocDate(doc.due_date)}
                          <span className={`ms-2 rounded-full px-2.5 py-0.5 text-xs font-semibold ${isRfqOpen(doc.due_date ?? '') ? 'bg-emerald-50 text-emerald-700' : 'bg-slate-100 text-slate-600'}`}>
                            {isRfqOpen(doc.due_date ?? '') ? 'פתוחה להצעות' : 'נסגרה — קישורי הספקים לקריאה בלבד'}
                          </span>
                        </dd>
                      </div>
                    )}
                    {doc.title && <div><dt className="text-ink-3">תיאור</dt><dd className="font-semibold text-ink">{doc.title}</dd></div>}
                    {doc.source_rfq_id && (
                      <div><dt className="text-ink-3">נפתחה מבקשה</dt><dd className="font-semibold tabular-nums text-ink">מספר {doc.source_rfq_number}</dd></div>
                    )}
                    <div><dt className="text-ink-3">שיעור מע״מ שנקבע בהפקה</dt><dd className="font-semibold tabular-nums text-ink">{formatVatRate(doc.vat_rate)}</dd></div>
                    {doc.notes && <div className="sm:col-span-2"><dt className="text-ink-3">הערות</dt><dd className="whitespace-pre-wrap text-ink">{doc.notes}</dd></div>}
                  </dl>
                </Section>

                <Section title="שורות" icon={ListChecks} iconTone="emerald">
                  <div className="space-y-3 py-2">
                    <div className="overflow-x-auto rounded-xl border border-line bg-white">
                      <table className="w-full min-w-[420px] border-collapse text-sm">
                        <thead>
                          <tr className="border-b border-line bg-slate-50/80">
                            <th className="px-4 py-3 text-start font-semibold text-ink-2">פירוט</th>
                            <th className="px-4 py-3 text-start font-semibold text-ink-2">כמות</th>
                            {priced && <th className="px-4 py-3 text-start font-semibold text-ink-2">מחיר</th>}
                            {priced && <th className="px-4 py-3 text-start font-semibold text-ink-2">סה״כ</th>}
                          </tr>
                        </thead>
                        <tbody>
                          {detail.lines.map((l, i) => (
                            <tr key={l.id} className={`border-b border-line last:border-0 ${i % 2 ? 'bg-slate-50/60' : ''}`}>
                              <td className="px-4 py-3 text-ink">{l.description}</td>
                              <td className="px-4 py-3 tabular-nums text-ink-2">{formatQty(l.quantity)}</td>
                              {priced && <td className="px-4 py-3 tabular-nums text-ink-2" dir="ltr">{l.unit_price === null ? '' : formatIls(l.unit_price)}</td>}
                              {priced && <td className="px-4 py-3 font-semibold tabular-nums text-ink" dir="ltr">{l.unit_price === null ? '' : formatIls(lineTotal(l))}</td>}
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                    {totals && (
                      <dl className="ms-auto w-full max-w-xs space-y-2 rounded-lg border border-line bg-white p-4 text-sm" data-totals>
                        <div className="flex justify-between gap-4"><dt className="text-ink-2">סה״כ לפני מע״מ</dt><dd className="font-semibold tabular-nums" dir="ltr">{formatIls(totals.subtotal)}</dd></div>
                        <div className="flex justify-between gap-4"><dt className="text-ink-2">מע״מ {formatVatRate(doc.vat_rate)}</dt><dd className="font-semibold tabular-nums" dir="ltr">{formatIls(totals.vat)}</dd></div>
                        <div className="flex justify-between gap-4 border-t border-line pt-2 text-base"><dt className="font-bold text-ink">סה״כ לתשלום</dt><dd className="font-bold tabular-nums" dir="ltr">{formatIls(totals.total)}</dd></div>
                      </dl>
                    )}
                  </div>
                </Section>

                {detail.files.length > 0 && (
                  <Section title="קבצים מצורפים" icon={Paperclip} iconTone="violet">
                    <ul className="space-y-2 py-2">
                      {detail.files.map((f) => (
                        <li key={f.id}>
                          <a href={f.url} target="_blank" rel="noopener noreferrer" className="flex min-h-11 items-center gap-3 rounded-lg border border-line bg-white px-3 py-2 hover:bg-slate-50">
                            <FileText className="h-4 w-4 shrink-0 text-rose-600" aria-hidden />
                            <span className="min-w-0 flex-1 truncate text-sm font-semibold text-ink">{f.original_filename}</span>
                            <span className="text-xs tabular-nums text-ink-3">{formatFileSize(f.file_size)}</span>
                          </a>
                        </li>
                      ))}
                    </ul>
                  </Section>
                )}

                {isRfq && (
                  <QuotesSection
                    detail={detail} canEdit={canEdit} onChanged={reload}
                    onCreatePo={(p) => { onClose(); onCreatePo(p); }}
                  />
                )}

                {detail.dispatches.length > 0 && (
                  <Section title="יומן שליחות" icon={History} iconTone="slate">
                    <ul className="space-y-2 py-2" data-dispatches>
                      {detail.dispatches.map((d) => (
                        <li key={d.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-lg border border-line bg-white p-3 text-sm">
                          <span className="font-semibold text-ink">{d.supplier_name}</span>
                          <span className="text-ink-3">{d.channel === 'email' ? 'מייל' : 'WhatsApp'}</span>
                          <span className={`rounded-full px-2.5 py-0.5 text-xs font-semibold ${d.status === 'sent' ? 'bg-emerald-50 text-emerald-700' : 'bg-rose-50 text-rose-700'}`}>
                            {d.status === 'sent' ? 'נשלח' : 'נכשל'}
                          </span>
                          <span className="ms-auto text-xs tabular-nums text-ink-3">{formatStampIL(d.sent_at)}</span>
                          {d.error && <span className="w-full text-xs text-rose-600">{d.error}</span>}
                        </li>
                      ))}
                    </ul>
                  </Section>
                )}
              </>
            )}
          </div>

          {detail && doc && canEdit && (
            <footer className="flex-none border-t border-slate-200 bg-white px-5 py-3 pb-[max(0.75rem,env(safe-area-inset-bottom))]">
              <div className="grid grid-cols-3 gap-2 sm:flex sm:flex-wrap sm:items-center">
                <Button type="button" onClick={() => setSendOpen(true)} className="h-11 gap-2"><Send className="h-4 w-4" /> שליחה</Button>
                <Button type="button" variant="outline" onClick={() => onEdit(detail)} className="h-11 gap-2"><Pencil className="h-4 w-4" /> עריכה</Button>
                <Button type="button" variant="outline" disabled={deleting} onClick={remove} className="h-11 gap-2 text-rose-600 hover:bg-rose-50 sm:ms-auto">
                  <Trash2 className="h-4 w-4" /> מחיקה
                </Button>
              </div>
            </footer>
          )}
        </SheetContent>
      </Sheet>

      {detail && (
        <>
          <SendSheet open={sendOpen} detail={detail} suppliers={suppliers} onOpenChange={setSendOpen} onSent={reload} />
        </>
      )}
    </>
  );
}
