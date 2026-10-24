'use client';

// /purchasing ("רכש") — the two documents in two tabs: בקשות להצעת מחיר and
// הזמנות רכש. The gear icon opens the letterhead settings (inside this module,
// not the general settings). Creating a document the first time, with no
// company details yet, opens the one-time wizard first and then continues to
// the document. Every create / edit is a side panel (DESIGN §12).

import { useCallback, useEffect, useMemo, useState } from 'react';
import { ClipboardList, Plus, Settings, ShoppingCart, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { formatDocDate, formatIls, isRfqOpen, round2, type DocType } from '@/lib/purchasing/model';
import { PURCHASING_SEEN_EVENT } from './unseen';
import { CompanySheet, type CompanyState } from './CompanySheet';
import { DocumentFormSheet } from './DocumentFormSheet';
import { DocumentDetailSheet } from './DocumentDetailSheet';
import type { DocumentDetail, DocumentListItem, PoPrefill, SequenceState, SupplierBrief } from './types';

interface Props {
  initialRfq: DocumentListItem[];
  initialPo: DocumentListItem[];
  company: CompanyState;
  sequences: SequenceState;
  suppliers: SupplierBrief[];
  canEdit: boolean;
  initialTab: DocType;
  /** A request to open on arrival (the link inside a notification). */
  initialOpenId: string | null;
}

const TABS: Array<{ type: DocType; label: string; icon: typeof ClipboardList }> = [
  { type: 'rfq', label: 'בקשות להצעת מחיר', icon: ClipboardList },
  { type: 'po', label: 'הזמנות רכש', icon: ShoppingCart },
];

export function PurchasingClient({ initialRfq, initialPo, company: initialCompany, sequences: initialSeq, suppliers, canEdit, initialTab, initialOpenId }: Props) {
  const [tab, setTab] = useState<DocType>(initialTab);
  const [lists, setLists] = useState<Record<DocType, DocumentListItem[]>>({
    // A request opened on arrival (a notification link) starts with its marker already cleared.
    rfq: initialOpenId ? initialRfq.map((d) => (d.id === initialOpenId ? { ...d, unseen_quote_count: 0 } : d)) : initialRfq,
    po: initialPo,
  });
  const [company, setCompany] = useState<CompanyState>(initialCompany);
  const [sequences, setSequences] = useState<SequenceState>(initialSeq);
  const [companyOpen, setCompanyOpen] = useState(false);
  const [wizard, setWizard] = useState(false);
  const [pendingType, setPendingType] = useState<DocType | null>(null);
  const [form, setForm] = useState<{ open: boolean; type: DocType; detail: DocumentDetail | null; prefill: PoPrefill | null }>(
    { open: false, type: 'rfq', detail: null, prefill: null },
  );
  const [detailId, setDetailId] = useState<string | null>(initialOpenId);
  const [refreshKey, setRefreshKey] = useState(0);

  const reload = useCallback(async () => {
    try {
      const [rfq, po, seq] = await Promise.all([
        fetch('/api/purchasing/documents?type=rfq', { credentials: 'include' }).then((r) => r.json()),
        fetch('/api/purchasing/documents?type=po', { credentials: 'include' }).then((r) => r.json()),
        fetch('/api/purchasing/company', { credentials: 'include' }).then((r) => r.json()),
      ]);
      setLists({ rfq: rfq.documents ?? [], po: po.documents ?? [] });
      if (seq.sequences) setSequences(seq.sequences);
    } catch { /* the list on screen stays */ }
  }, []);

  function switchTab(t: DocType) {
    setTab(t);
    window.history.replaceState(null, '', `/purchasing?tab=${t}`);
  }

  /** A draft opens straight in the form (from any device — it lives on the server). */
  async function openDraft(id: string) {
    try {
      const res = await fetch(`/api/purchasing/documents/${id}`, { credentials: 'include' });
      if (!res.ok) throw new Error('load failed');
      const d: DocumentDetail = await res.json();
      setForm({ open: true, type: d.document.doc_type, detail: d, prefill: null });
    } catch {
      toast.error('טעינת הטיוטה נכשלה');
    }
  }

  async function removeDraft(id: string) {
    if (!window.confirm('למחוק את הטיוטה?')) return;
    try {
      const res = await fetch(`/api/purchasing/documents/${id}`, { method: 'DELETE' });
      if (!res.ok) throw new Error('delete failed');
      toast.success('הטיוטה נמחקה');
      void reload();
    } catch {
      toast.error('המחיקה נכשלה');
    }
  }

  function startNew(type: DocType, prefill: PoPrefill | null = null) {
    if (!company.complete) {
      setPendingType(type);
      setWizard(true);
      setCompanyOpen(true);
      return;
    }
    setForm({ open: true, type, detail: null, prefill });
  }

  const rows = useMemo(() => lists[tab], [lists, tab]);

  // Opening a request is what marks its quotes as seen (the GET stamps the
  // document): the row's marker is cleared at once (openDetail), and the menu
  // badge recounts a moment later, once the stamp is certainly written.
  function openDetail(id: string) {
    setLists((prev) => ({
      ...prev,
      rfq: prev.rfq.map((d) => (d.id === id && d.unseen_quote_count > 0 ? { ...d, unseen_quote_count: 0 } : d)),
    }));
    setDetailId(id);
  }

  useEffect(() => {
    if (!detailId) return;
    const t = window.setTimeout(() => window.dispatchEvent(new Event(PURCHASING_SEEN_EVENT)), 1200);
    return () => window.clearTimeout(t);
  }, [detailId]);

  return (
    <div className="space-y-6">
      <header className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
        <div>
          <h1 className="text-2xl font-extrabold text-slate-900">רכש</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            בקשות להצעת מחיר לספקים והזמנות רכש — מופקות על נייר המכתבים של החברה, עם PDF ושליחה במייל ו-WhatsApp.
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-3">
          {canEdit && (
            <button
              type="button"
              onClick={() => { setWizard(false); setCompanyOpen(true); }}
              aria-label="הגדרות רכש — נייר מכתבים"
              title="הגדרות רכש"
              className="grid h-11 w-11 place-items-center rounded-lg border border-line bg-white text-ink-2 transition-colors hover:bg-slate-50"
            >
              <Settings className="h-5 w-5" />
            </button>
          )}
          {canEdit && (
            <Button type="button" onClick={() => startNew(tab)} className="gap-2">
              <Plus className="h-4 w-4" />
              {tab === 'rfq' ? 'בקשה חדשה' : 'הזמנה חדשה'}
            </Button>
          )}
        </div>
      </header>

      <div role="tablist" aria-label="סוג מסמך" className="flex flex-wrap gap-2 border-b border-line">
        {TABS.map((t) => {
          const active = tab === t.type;
          return (
            <button
              key={t.type}
              role="tab"
              type="button"
              aria-selected={active}
              data-tab={t.type}
              onClick={() => switchTab(t.type)}
              className={cn(
                'inline-flex min-h-11 items-center gap-2 border-b-2 px-4 py-2 text-sm font-semibold transition-colors',
                active ? 'border-brand text-brand' : 'border-transparent text-ink-3 hover:text-ink',
              )}
            >
              <t.icon className="h-4 w-4" aria-hidden />
              {t.label}
              <span className="rounded-full bg-slate-100 px-2 py-0.5 text-xs tabular-nums text-ink-2">{lists[t.type].length}</span>
            </button>
          );
        })}
      </div>

      {rows.length === 0 ? (
        <div className="rounded-lg border bg-card p-12 text-center text-sm text-muted-foreground" data-empty>
          עדיין לא הופקו {tab === 'rfq' ? 'בקשות להצעת מחיר' : 'הזמנות רכש'}.
          {canEdit && ` לחצו על "${tab === 'rfq' ? 'בקשה חדשה' : 'הזמנה חדשה'}" כדי להתחיל.`}
        </div>
      ) : (
        <div className="overflow-x-auto rounded-xl border border-line bg-white shadow-soft-xs">
          <table className="w-full min-w-[840px] border-collapse text-sm" data-list={tab}>
            <thead>
              <tr className="border-b border-line bg-slate-50/80 text-start">
                <th className="px-4 py-3 text-start font-semibold text-ink-2">מספר</th>
                <th className="px-4 py-3 text-start font-semibold text-ink-2">תאריך</th>
                {tab === 'po' && <th className="px-4 py-3 text-start font-semibold text-ink-2">ספק</th>}
                <th className="px-4 py-3 text-start font-semibold text-ink-2">{tab === 'rfq' ? 'נושא' : 'תיאור'}</th>
                {tab === 'rfq' ? (
                  <>
                    <th className="px-4 py-3 text-start font-semibold text-ink-2">יעד להגשה</th>
                    <th className="px-4 py-3 text-start font-semibold text-ink-2">הצעות</th>
                    <th className="px-4 py-3 text-start font-semibold text-ink-2">זוכה</th>
                  </>
                ) : (
                  <th className="px-4 py-3 text-start font-semibold text-ink-2">סה״כ לתשלום</th>
                )}
                <th className="w-14 px-2 py-3"><span className="sr-only">פעולות</span></th>
              </tr>
            </thead>
            <tbody>
              {rows.map((d) => {
                const vat = round2((d.subtotal * d.vat_rate) / 100);
                return (
                  <tr
                    key={d.id}
                    data-doc={d.id}
                    data-number={d.number ?? undefined}
                    data-draft={d.status === 'draft' ? '' : undefined}
                    tabIndex={0}
                    onClick={() => (d.status === 'draft' ? void openDraft(d.id) : openDetail(d.id))}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); if (d.status === 'draft') void openDraft(d.id); else openDetail(d.id); }
                    }}
                    data-new-quotes={d.unseen_quote_count > 0 ? d.unseen_quote_count : undefined}
                    className={cn(
                      'cursor-pointer border-b border-line transition-colors last:border-0 hover:bg-row-hover focus-visible:bg-row-hover focus-visible:outline-none',
                      d.unseen_quote_count > 0 && 'bg-blue-50/60',
                    )}
                  >
                    <td className="px-4 py-3 font-bold tabular-nums text-ink">
                      {d.status === 'draft' ? (
                        <span className="rounded-full bg-amber-100 px-2.5 py-0.5 text-xs font-bold text-amber-800">טיוטה</span>
                      ) : d.number}
                    </td>
                    <td className="px-4 py-3 tabular-nums text-ink-2">{formatDocDate(d.doc_date)}</td>
                    {tab === 'po' && <td className="px-4 py-3 font-semibold text-ink">{d.supplier_name ?? '—'}</td>}
                    <td className="px-4 py-3 text-ink-2">
                      <span className="inline-flex flex-wrap items-center gap-2">
                        <span className={cn(d.unseen_quote_count > 0 && 'font-semibold text-ink')}>{d.title || '—'}</span>
                        {d.unseen_quote_count > 0 && (
                          <span data-new-quote-tag className="rounded-full bg-blue-100 px-2.5 py-0.5 text-xs font-bold text-blue-700">הצעה חדשה</span>
                        )}
                      </span>
                    </td>
                    {tab === 'rfq' ? (
                      <>
                        <td className="px-4 py-3 tabular-nums text-ink-2">
                          {formatDocDate(d.due_date)}
                          {d.due_date && !isRfqOpen(d.due_date) && (
                            <span className="ms-2 rounded-full bg-slate-100 px-2 py-0.5 text-xs font-semibold text-slate-600">נסגרה</span>
                          )}
                        </td>
                        <td className="px-4 py-3 tabular-nums text-ink-2">{d.quote_count} מתוך {Math.max(d.recipient_count, d.quote_count)}</td>
                        <td className="px-4 py-3 text-ink-2">{d.winner_supplier_name ?? '—'}</td>
                      </>
                    ) : (
                      <td className="px-4 py-3 font-semibold tabular-nums text-ink" dir="ltr">{formatIls(d.subtotal + vat)}</td>
                    )}
                    <td className="px-2 py-1 text-end">
                      {canEdit && d.status === 'draft' && (
                        <button
                          type="button" aria-label="מחיקת הטיוטה" title="מחיקת הטיוטה" data-delete-draft
                          onClick={(e) => { e.stopPropagation(); void removeDraft(d.id); }}
                          onKeyDown={(e) => e.stopPropagation()}
                          className="grid h-11 w-11 place-items-center rounded-lg text-ink-3 hover:bg-rose-50 hover:text-rose-600"
                        >
                          <Trash2 className="h-4 w-4" />
                        </button>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      <CompanySheet
        open={companyOpen}
        wizard={wizard}
        state={company}
        onOpenChange={(o) => { setCompanyOpen(o); if (!o) { setWizard(false); setPendingType(null); } }}
        onSaved={(s) => {
          setCompany(s);
          // The wizard continues to the document the user asked for.
          if (wizard && pendingType && s.complete) {
            const t = pendingType;
            setPendingType(null);
            setWizard(false);
            setForm({ open: true, type: t, detail: null, prefill: null });
          }
        }}
      />

      <DocumentFormSheet
        open={form.open}
        type={form.type}
        detail={form.detail}
        prefill={form.prefill}
        vatRate={company.company.vat_rate}
        sequences={sequences}
        suppliers={suppliers}
        onOpenChange={(o) => setForm((f) => ({ ...f, open: o }))}
        onNeedCompany={() => { setForm((f) => ({ ...f, open: false })); setPendingType(form.type); setWizard(true); setCompanyOpen(true); }}
        onSaved={(id, issued) => {
          void reload();
          setTab(form.type);
          // A saved draft only refreshes the list; an issued document opens its panel.
          if (!issued) return;
          setRefreshKey((k) => k + 1);
          setDetailId(id);
        }}
      />

      <DocumentDetailSheet
        documentId={detailId}
        canEdit={canEdit}
        suppliers={suppliers}
        refreshKey={refreshKey}
        onClose={() => setDetailId(null)}
        onEdit={(d) => { setDetailId(null); setForm({ open: true, type: d.document.doc_type, detail: d, prefill: null }); }}
        onCreatePo={(p) => { switchTab('po'); startNew('po', p); }}
        onChanged={() => void reload()}
      />
    </div>
  );
}

