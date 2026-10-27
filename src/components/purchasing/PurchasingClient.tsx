'use client';

// /purchasing ("רכש") — the two documents in two tabs: בקשות להצעת מחיר and
// הזמנות רכש, each with the same search + date-range row and the same table
// (DocumentsTable). The gear icon opens the letterhead settings (inside this
// module, not the general settings). Creating a document the first time, with
// no company details yet, opens the one-time wizard first and then continues to
// the document. Every create / edit is a side panel (DESIGN §12); a delete is
// confirmed in an AlertDialog.

import { useCallback, useEffect, useMemo, useState } from 'react';
import { ClipboardList, Plus, Settings, ShoppingCart } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import type { DocType } from '@/lib/purchasing/model';
import { PURCHASING_SEEN_EVENT } from './unseen';
import { CompanySheet, type CompanyState } from './CompanySheet';
import { DeleteDocumentDialog } from './DeleteDocumentDialog';
import { DocumentFormSheet } from './DocumentFormSheet';
import { DocumentDetailSheet } from './DocumentDetailSheet';
import { DocumentsTable } from './DocumentsTable';
import { ListFilters } from './ListFilters';
import { EMPTY_FILTER, filterDocuments, isFiltering, sortDocuments, type ListFilter } from './listView';
import type { DocumentDetail, DocumentListItem, PoPrefill, SequenceState, SupplierBrief } from './types';

interface Props {
  initialRfq: DocumentListItem[];
  initialPo: DocumentListItem[];
  company: CompanyState;
  sequences: SequenceState;
  suppliers: SupplierBrief[];
  /** View / edit level per document type — each has its own permission key. */
  access: Record<DocType, { view: boolean; edit: boolean }>;
  /** Letterhead and numbering: admin and up. */
  canSettings: boolean;
  initialTab: DocType;
  /** A request to open on arrival (the link inside a notification). */
  initialOpenId: string | null;
}

const TABS: Array<{ type: DocType; label: string; icon: typeof ClipboardList }> = [
  { type: 'rfq', label: 'בקשות להצעת מחיר', icon: ClipboardList },
  { type: 'po', label: 'הזמנות רכש', icon: ShoppingCart },
];

export function PurchasingClient({ initialRfq, initialPo, company: initialCompany, sequences: initialSeq, suppliers, access, canSettings, initialTab, initialOpenId }: Props) {
  const [tab, setTab] = useState<DocType>(initialTab);
  const canEdit = access[tab].edit;
  const tabs = TABS.filter((t) => access[t.type].view);
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
  // The send icon opens the window on its suppliers card (a PO: straight into the send panel).
  const [detailIntent, setDetailIntent] = useState<'suppliers' | null>(null);
  // A single click only selects the row; a double-click (or Enter) opens it.
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);
  // The search and the date range hold across the two tabs; a delete waits for its confirmation.
  const [filter, setFilter] = useState<ListFilter>(EMPTY_FILTER);
  const [deleteTarget, setDeleteTarget] = useState<DocumentListItem | null>(null);
  const [deleting, setDeleting] = useState(false);

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

  /** Runs after "מחק" in the confirmation: a draft goes for good, an issued document is closed (the route's rule). */
  async function confirmDelete() {
    const doc = deleteTarget;
    if (!doc || deleting) return;
    setDeleting(true);
    try {
      const res = await fetch(`/api/purchasing/documents/${doc.id}`, { method: 'DELETE', credentials: 'include' });
      if (!res.ok) throw new Error('delete failed');
      toast.success(doc.status === 'draft' ? 'הטיוטה נמחקה' : 'המסמך נמחק');
      setLists((prev) => ({ ...prev, [doc.doc_type]: prev[doc.doc_type].filter((d) => d.id !== doc.id) }));
      setSelectedId((cur) => (cur === doc.id ? null : cur));
      void reload();
      // A request that held unseen quotes just left the menu badge's count.
      window.dispatchEvent(new Event(PURCHASING_SEEN_EVENT));
    } catch {
      toast.error('המחיקה נכשלה');
    } finally {
      setDeleting(false);
      setDeleteTarget(null);
    }
  }

  function startNew(type: DocType, prefill: PoPrefill | null = null) {
    if (!company.complete) {
      if (!canSettings) {
        toast.error('נייר המכתבים של החברה טרם הוגדר — יש לבקש ממנהל להגדיר אותו ברכש');
        return;
      }
      setPendingType(type);
      setWizard(true);
      setCompanyOpen(true);
      return;
    }
    setForm({ open: true, type, detail: null, prefill });
  }

  const rows = useMemo(() => sortDocuments(filterDocuments(lists[tab], filter)), [lists, tab, filter]);

  // Opening a request is what marks its quotes as seen (the GET stamps the
  // document): the row's marker is cleared at once (openDetail), and the menu
  // badge recounts a moment later, once the stamp is certainly written.
  function openDetail(id: string, intent: 'suppliers' | null = null) {
    setLists((prev) => ({
      ...prev,
      rfq: prev.rfq.map((d) => (d.id === id && d.unseen_quote_count > 0 ? { ...d, unseen_quote_count: 0 } : d)),
    }));
    setDetailIntent(intent);
    setDetailId(id);
  }

  function openRow(d: DocumentListItem) {
    if (d.status === 'draft') void openDraft(d.id);
    else openDetail(d.id);
  }

  useEffect(() => {
    if (!detailId) return;
    const t = window.setTimeout(() => window.dispatchEvent(new Event(PURCHASING_SEEN_EVENT)), 1200);
    return () => window.clearTimeout(t);
  }, [detailId]);

  const noun = tab === 'rfq' ? 'בקשות להצעת מחיר' : 'הזמנות רכש';

  return (
    <div className="space-y-6">
      <header className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
        <div className="min-w-0">
          <h1 className="text-2xl font-extrabold text-slate-900">רכש</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            בקשות להצעת מחיר לספקים והזמנות רכש — מופקות על נייר המכתבים של החברה, עם PDF ושליחה במייל ו-WhatsApp.
          </p>
        </div>
        <div className="flex shrink-0 flex-wrap items-center gap-3">
          {canSettings && (
            <Button
              type="button" variant="outline" size="icon"
              onClick={() => { setWizard(false); setCompanyOpen(true); }}
              aria-label="הגדרות רכש — נייר מכתבים"
              title="הגדרות רכש"
            >
              <Settings className="h-5 w-5" />
            </Button>
          )}
          {canEdit && (
            <Button type="button" onClick={() => startNew(tab)} className="gap-2">
              <Plus className="h-4 w-4" />
              {tab === 'rfq' ? 'בקשה חדשה' : 'הזמנה חדשה'}
            </Button>
          )}
        </div>
      </header>

      <div role="tablist" aria-label="סוג מסמך" className="flex flex-wrap gap-x-2 border-b border-line">
        {tabs.map((t) => {
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
                '-mb-px inline-flex min-h-11 cursor-pointer items-center gap-2 border-b-2 px-4 py-2 text-sm transition-colors',
                active ? 'border-brand font-semibold text-brand' : 'border-transparent font-medium text-slate-500 hover:text-slate-700',
              )}
            >
              <t.icon className="h-4 w-4" aria-hidden />
              {t.label}
              <span className={cn('rounded-full px-2 py-0.5 text-xs font-bold tabular-nums', active ? 'bg-blue-100 text-blue-700' : 'bg-slate-100 text-slate-600')}>
                {lists[t.type].length}
              </span>
            </button>
          );
        })}
      </div>

      <ListFilters filter={filter} onChange={setFilter} />

      {rows.length === 0 ? (
        <div className="rounded-lg border bg-card p-12 text-center text-sm text-muted-foreground" data-empty>
          {lists[tab].length > 0 && isFiltering(filter)
            ? 'לא נמצאו מסמכים התואמים לחיפוש או לטווח התאריכים.'
            : `עדיין לא הופקו ${noun}.${canEdit ? ` לחצו על "${tab === 'rfq' ? 'בקשה חדשה' : 'הזמנה חדשה'}" כדי להתחיל.` : ''}`}
        </div>
      ) : (
        <DocumentsTable
          tab={tab}
          rows={rows}
          selectedId={selectedId}
          canEdit={canEdit}
          onSelect={setSelectedId}
          onOpen={openRow}
          onSend={(id) => openDetail(id, 'suppliers')}
          onDelete={setDeleteTarget}
        />
      )}

      <DeleteDocumentDialog doc={deleteTarget} busy={deleting} onCancel={() => setDeleteTarget(null)} onConfirm={() => void confirmDelete()} />

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
        onNeedCompany={() => {
          setForm((f) => ({ ...f, open: false }));
          if (!canSettings) { toast.error('נייר המכתבים של החברה טרם הוגדר — יש לבקש ממנהל להגדיר אותו ברכש'); return; }
          setPendingType(form.type); setWizard(true); setCompanyOpen(true);
        }}
        onSaved={() => {
          void reload();
          setTab(form.type);
          // The form closes and the user is back on the table: nothing opens on top of another window.
          setRefreshKey((k) => k + 1);
        }}
      />

      <DocumentDetailSheet
        documentId={detailId}
        canEdit={canEdit}
        canCreatePo={access.po.edit}
        suppliers={suppliers}
        refreshKey={refreshKey}
        intent={detailIntent}
        onClose={() => { setDetailId(null); setDetailIntent(null); }}
        onEdit={(d) => { setDetailId(null); setDetailIntent(null); setForm({ open: true, type: d.document.doc_type, detail: d, prefill: null }); }}
        onCreatePo={(p) => { switchTab('po'); startNew('po', p); }}
        onChanged={() => void reload()}
      />
    </div>
  );
}

