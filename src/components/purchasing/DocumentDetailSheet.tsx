'use client';

// The read view of one document (DESIGN §12 — a side panel). The header carries the title (a
// request: its subject under it), the close button and the tabs: "מסמך" (details, lines and — for
// a request — the suppliers card), "השוואת הצעות" (request only) and "יומן שליחות". The bottom bar
// is fixed, outside the scrolling area, in every tab: delete on the right; edit · PDF · print
// (a purchase order: · send) on the left. Everything is fetched from /api/purchasing/documents/[id].

import { useCallback, useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import { Award, Download, FileText, Hash, History, ListChecks, Loader2, Paperclip, Pencil, Printer, Send, Trash2, X } from 'lucide-react';
import { Sheet, SheetContent, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { cn } from '@/lib/utils';
import { Section } from '@/components/side-panel/Section';
import { formatFileSize } from '@/lib/decisions';
import { printPdf } from '@/lib/purchasing/printPdf';
import {
  computeTotals, docHeading, formatDocDate, formatIls, formatQty, formatVatRate, isRfqOpen, lineTotal, partyKey,
} from '@/lib/purchasing/model';
import { ComparisonTab } from './ComparisonTab';
import { DispatchLog } from './DispatchLog';
import { PartyPdfMenu } from './PartyPdfMenu';
import { pdfHref } from './pdfActions';
import { SuppliersCard } from './SuppliersCard';
import { SendSheet } from './SendSheet';
import type { DocumentDetail, PoPrefill, SupplierBrief } from './types';

type PanelTab = 'document' | 'compare' | 'log';

const FOOT_BTN = 'inline-flex h-11 items-center gap-2 rounded-lg border px-4 text-sm font-semibold transition-colors disabled:pointer-events-none disabled:opacity-50';
const FOOT_OUTLINE = `${FOOT_BTN} border-line bg-white text-ink hover:bg-slate-50`;

interface Props {
  documentId: string | null;
  canEdit: boolean;
  /** May turn a winning quote into a purchase order (edit level on the ORDERS key). */
  canCreatePo: boolean;
  suppliers: SupplierBrief[];
  /** Bumped by the parent after any save so an open panel re-reads. */
  refreshKey: number;
  /** 'suppliers' = opened by a row's send icon: land on the suppliers card (a purchase order: open its send sheet). */
  intent?: 'suppliers' | null;
  onClose: () => void;
  onEdit: (detail: DocumentDetail) => void;
  onCreatePo: (prefill: PoPrefill) => void;
  /** The list behind the panel changed (send, quote, winner, delete). */
  onChanged: () => void;
}

export function DocumentDetailSheet({ documentId, canEdit, canCreatePo, suppliers, refreshKey, intent = null, onClose, onEdit, onCreatePo, onChanged }: Props) {
  const [detail, setDetail] = useState<DocumentDetail | null>(null);
  const [loading, setLoading] = useState(false);
  const [sendOpen, setSendOpen] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [printing, setPrinting] = useState(false);
  // Keyed by document: every document opens on its own first tab.
  const [picked, setPicked] = useState<{ id: string | null; tab: PanelTab }>({ id: null, tab: 'document' });
  const tab: PanelTab = picked.id === documentId ? picked.tab : 'document';
  const setTab = (t: PanelTab) => setPicked({ id: documentId, tab: t });
  const handledIntent = useRef<string | null>(null);

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

  const doc = detail?.document;
  const isRfq = doc?.doc_type === 'rfq';

  // The send icon of a list row: a request lands on its suppliers card, an order opens its send sheet.
  // Once per (document, intent) — a later reload must not scroll or open it again.
  useEffect(() => {
    if (!intent || !documentId) { handledIntent.current = null; return; }
    if (!detail || !doc || doc.id !== documentId) return;
    const key = `${documentId}:${intent}`;
    if (handledIntent.current === key) return;
    handledIntent.current = key;
    const isPo = doc.doc_type === 'po';
    const t = window.setTimeout(() => {
      setPicked({ id: documentId, tab: 'document' });
      if (isPo) { setSendOpen(true); return; }
      // The card exists only after the document tab has rendered.
      window.setTimeout(() => {
        document.querySelector('[data-suppliers-card]')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
      }, 60);
    }, 0);
    return () => window.clearTimeout(t);
  }, [intent, documentId, detail, doc]);

  const reload = () => { if (documentId) void load(documentId); onChanged(); };

  async function remove() {
    if (!detail) return;
    const d = detail.document;
    if (!window.confirm(`למחוק את ${docHeading(d.doc_type, d.number ?? 0)}? המספר לא ישוחזר ולא ייעשה בו שימוש שוב.`)) return;
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

  async function printPo() {
    if (!doc) return;
    setPrinting(true);
    try {
      await printPdf(pdfHref(doc.id, null, false));
    } catch {
      toast.error('ההדפסה נכשלה');
    } finally {
      setPrinting(false);
    }
  }

  const priced = !!detail && (!isRfq || detail.lines.some((l) => l.unit_price !== null));
  const totals = detail && doc && priced && !isRfq ? computeTotals(detail.lines, doc.vat_rate) : null;
  // A draft has no number and no PDF — the PDF actions stay on screen, disabled.
  const isDraft = doc?.status === 'draft';
  const parties = (detail?.recipients ?? []).map((r) => ({ key: partyKey(r), name: r.supplier_name }));
  const open = !!doc?.due_date && isRfqOpen(doc.due_date);
  const submitted = detail?.quotes?.length ?? 0;
  const tabs: Array<{ key: PanelTab; label: string; icon: typeof Hash; count?: number }> = [
    { key: 'document', label: 'מסמך', icon: FileText },
    ...(isRfq ? [{ key: 'compare' as const, label: 'השוואת הצעות', icon: Award, count: submitted }] : []),
    { key: 'log', label: 'יומן שליחות', icon: History },
  ];

  return (
    <>
      {/* While a child sheet (send) is open, Escape and the backdrop
          belong to IT — closing both at once would drop the user out of the document. */}
      <Sheet open={!!documentId} onOpenChange={(o) => { if (!o && !sendOpen) onClose(); }}>
        <SheetContent
          side="left" dir="rtl" showCloseButton={false}
          className="w-full max-w-full p-0 sm:w-[92vw] md:w-[80vw] lg:w-[55vw] lg:min-w-[720px] flex flex-col gap-0 overflow-hidden bg-white"
        >
          <SheetHeader className="flex-none gap-2 bg-gradient-to-bl from-slate-900 via-blue-950 to-blue-900 px-6 pb-0 pt-6 text-white">
            <div className="flex items-start justify-between gap-4">
              <div className="min-w-0 flex-1">
                <SheetTitle className="text-2xl font-bold text-white">
                  {doc ? docHeading(doc.doc_type, doc.number ?? 0) : 'טוען…'}
                </SheetTitle>
                <p className="mt-1 truncate text-sm text-white/70" data-doc-subtitle>
                  {doc ? (isRfq ? doc.title : [doc.title, doc.supplier_name].filter(Boolean).join(' · ')) : ''}
                </p>
              </div>
              <button
                type="button" onClick={onClose} aria-label="סגור"
                className="flex h-11 w-11 shrink-0 items-center justify-center rounded-lg border border-white/25 bg-white/5 text-white transition-colors hover:border-white/50 hover:bg-white/15"
              >
                <X className="h-5 w-5" />
              </button>
            </div>

            {detail && doc && (
              <div role="tablist" aria-label="חלקי המסמך" className="mt-2 flex gap-1 overflow-x-auto" data-doc-tabs>
                {tabs.map((t) => {
                  const active = tab === t.key;
                  return (
                    <button
                      key={t.key} type="button" role="tab" aria-selected={active} data-doc-tab={t.key}
                      onClick={() => setTab(t.key)}
                      className={cn(
                        'inline-flex min-h-11 shrink-0 items-center gap-2 border-b-2 px-4 py-2 text-sm font-semibold transition-colors',
                        active ? 'border-white text-white' : 'border-transparent text-white/60 hover:text-white',
                      )}
                    >
                      <t.icon className="h-4 w-4" aria-hidden />
                      {t.label}
                      {t.count !== undefined && (
                        <span className="min-w-6 rounded-full bg-white/15 px-2 py-0.5 text-center text-xs font-bold tabular-nums" data-compare-count>{t.count}</span>
                      )}
                    </button>
                  );
                })}
              </div>
            )}
          </SheetHeader>

          <div className="flex-1 space-y-5 overflow-y-auto bg-slate-50/60 p-5" data-doc-scroll>
            {(loading && !detail) && (
              <div className="grid place-items-center p-12 text-ink-3"><Loader2 className="h-6 w-6 animate-spin" aria-label="טוען" /></div>
            )}

            {detail && doc && (
              <>
                {tab === 'document' && (
                <>
                <Section title="פרטי המסמך" icon={Hash} iconTone="blue">
                  <dl className="grid grid-cols-2 gap-x-6 gap-y-4 py-2 text-sm" data-doc-details>
                    <div><dt className="text-ink-3">מספר</dt><dd className="text-lg font-semibold tabular-nums text-ink">{doc.number}</dd></div>
                    <div><dt className="text-ink-3">תאריך</dt><dd className="text-lg font-semibold tabular-nums text-ink">{formatDocDate(doc.doc_date)}</dd></div>
                    {isRfq && (
                      <div>
                        <dt className="text-ink-3">תאריך יעד להגשה</dt>
                        <dd className="flex flex-wrap items-center gap-2 text-lg font-semibold tabular-nums text-ink">
                          {formatDocDate(doc.due_date)}
                          <span
                            data-due-badge={open ? 'open' : 'locked'}
                            className={cn('rounded-full border px-2.5 py-0.5 text-xs font-semibold', open ? 'border-emerald-200 bg-emerald-50 text-emerald-700' : 'border-slate-200 bg-slate-100 text-slate-600')}
                          >
                            {open ? 'פתוחה להצעות' : 'נעולה'}
                          </span>
                        </dd>
                      </div>
                    )}
                    {doc.supplier_name && <div><dt className="text-ink-3">ספק</dt><dd className="text-lg font-semibold text-ink">{doc.supplier_name}</dd></div>}
                    {!doc.supplier_id && (doc.supplier_phone || doc.supplier_email || doc.supplier_address) && (
                      <div>
                        <dt className="text-ink-3">פרטי הספק</dt>
                        <dd className="text-ink">{[doc.supplier_phone, doc.supplier_email, doc.supplier_address].filter(Boolean).join(' · ')}</dd>
                      </div>
                    )}
                    {doc.source_rfq_id && (
                      <div><dt className="text-ink-3">נפתחה מבקשה</dt><dd className="text-lg font-semibold tabular-nums text-ink">מספר {doc.source_rfq_number}</dd></div>
                    )}
                    <div><dt className="text-ink-3">שיעור מע״מ שנקבע בהפקה</dt><dd className="text-lg font-semibold tabular-nums text-ink">{formatVatRate(doc.vat_rate)}</dd></div>
                    {doc.title && <div className="col-span-2"><dt className="text-ink-3">תיאור</dt><dd className="text-lg font-semibold text-ink">{doc.title}</dd></div>}
                    {doc.notes && <div className="col-span-2"><dt className="text-ink-3">הערות</dt><dd className="whitespace-pre-wrap text-ink">{doc.notes}</dd></div>}
                  </dl>
                </Section>

                <Section title="שורות" icon={ListChecks} iconTone="emerald">
                  <div className="space-y-3 py-2">
                    <div className="overflow-x-auto rounded-xl border border-line bg-white">
                      <table className="w-full min-w-[320px] border-collapse text-sm">
                        <thead>
                          <tr className="border-b border-line bg-slate-50/80">
                            <th className="px-4 py-3 text-start font-semibold text-ink-3">פירוט</th>
                            <th className="px-4 py-3 text-start font-semibold text-ink-3">כמות</th>
                            {!isRfq && priced && <th className="px-4 py-3 text-start font-semibold text-ink-3">מחיר</th>}
                            {!isRfq && priced && <th className="px-4 py-3 text-start font-semibold text-ink-3">סה״כ</th>}
                          </tr>
                        </thead>
                        <tbody>
                          {detail.lines.map((l) => (
                            <tr key={l.id} className="border-b border-line last:border-0">
                              <td className="px-4 py-3 text-ink">{l.description}</td>
                              <td className="px-4 py-3 tabular-nums text-ink-2">{formatQty(l.quantity)}</td>
                              {!isRfq && priced && <td className="px-4 py-3 tabular-nums text-ink-2" dir="ltr">{l.unit_price === null ? '' : formatIls(l.unit_price)}</td>}
                              {!isRfq && priced && <td className="px-4 py-3 font-semibold tabular-nums text-ink" dir="ltr">{l.unit_price === null ? '' : formatIls(lineTotal(l))}</td>}
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
                  <SuppliersCard
                    detail={detail} suppliers={suppliers} canEdit={canEdit} onChanged={reload}
                    onShowComparison={() => setTab('compare')}
                  />
                )}
                </>
                )}

                {tab === 'compare' && isRfq && (
                  <ComparisonTab
                    detail={detail} canEdit={canEdit} canCreatePo={canCreatePo} onChanged={reload}
                    onCreatePo={(p) => { onClose(); onCreatePo(p); }}
                  />
                )}

                {tab === 'log' && <DispatchLog dispatches={detail.dispatches} />}
              </>
            )}
          </div>

          {detail && doc && (
            <footer
              className="flex flex-none flex-wrap items-center justify-between gap-2 border-t border-line bg-white px-5 py-3 pb-[max(0.75rem,env(safe-area-inset-bottom))]"
              data-doc-actions
            >
              {/* RTL: the first group sits on the right (delete), the second on the left. */}
              <div className="flex items-center gap-2">
                {canEdit && (
                  <button
                    type="button" disabled={deleting} onClick={remove} data-action="delete"
                    className={`${FOOT_BTN} border-rose-200 bg-white text-rose-700 hover:bg-rose-50`}
                  >
                    <Trash2 className="h-4 w-4" aria-hidden /> מחיקה
                  </button>
                )}
              </div>
              <div className="flex flex-wrap items-center gap-2" data-actions-left>
                {canEdit && !isRfq && (
                  <button
                    type="button" onClick={() => setSendOpen(true)} disabled={isDraft} data-action="send"
                    className={`${FOOT_BTN} border-slate-900 bg-slate-900 text-white hover:bg-slate-800`}
                  >
                    <Send className="h-4 w-4" aria-hidden /> שליחה
                  </button>
                )}
                {isRfq ? (
                  <PartyPdfMenu kind="print" documentId={doc.id} parties={parties} disabled={isDraft} className={FOOT_OUTLINE}>
                    <Printer className="h-4 w-4" aria-hidden /> הדפס
                  </PartyPdfMenu>
                ) : (
                  <button type="button" disabled={isDraft || printing} onClick={printPo} data-action="print" className={FOOT_OUTLINE}>
                    {printing ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : <Printer className="h-4 w-4" aria-hidden />} הדפס
                  </button>
                )}
                <PartyPdfMenu kind="download" documentId={doc.id} parties={isRfq ? parties : []} disabled={isDraft} className={FOOT_OUTLINE}>
                  <Download className="h-4 w-4" aria-hidden /> הורדת PDF
                </PartyPdfMenu>
                {canEdit && (
                  <button
                    type="button" onClick={() => onEdit(detail)} data-action="edit"
                    className={`${FOOT_BTN} border-brand bg-brand text-white hover:opacity-90`}
                  >
                    <Pencil className="h-4 w-4" aria-hidden /> עריכה
                  </button>
                )}
              </div>
            </footer>
          )}
        </SheetContent>
      </Sheet>

      {detail && !isRfq && (
        <SendSheet open={sendOpen} detail={detail} suppliers={suppliers} onOpenChange={setSendOpen} onSent={reload} />
      )}
    </>
  );
}
