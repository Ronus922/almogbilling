'use client';

// The table of /purchasing — the same card, header row, spacing and row actions for both tabs; only the
// columns differ. A request: מספר · תאריך · נושא (its suppliers under it) · יעד להגשה · הצעות · זוכה ·
// פעולות. An order: מספר · תאריך · ספק · תיאור · סה״כ לתשלום · פעולות. A single click selects a row; a
// double-click (or Enter / Space) opens it; the icons at its end never reach the row (RowActions).

import { cn } from '@/lib/utils';
import { formatDocDate, formatIls, isRfqOpen, round2, type DocType } from '@/lib/purchasing/model';
import { offersSummary, suppliersLine, type OffersTone } from './listView';
import { RowActions } from './RowActions';
import type { DocumentListItem } from './types';

interface Props {
  tab: DocType;
  rows: DocumentListItem[];
  selectedId: string | null;
  canEdit: boolean;
  onSelect: (id: string) => void;
  onOpen: (doc: DocumentListItem) => void;
  onSend: (id: string) => void;
  onDelete: (doc: DocumentListItem) => void;
}

const TH = 'px-4 py-3 text-start text-sm font-semibold text-slate-500';
const TD = 'px-4 py-5';

const PILL_TONE: Record<OffersTone, string> = {
  all: 'border-emerald-200 bg-emerald-50 text-emerald-700',
  some: 'border-amber-200 bg-amber-50 text-amber-700',
  none: 'border-transparent bg-slate-100 text-slate-600',
};

function OffersPill({ doc }: { doc: DocumentListItem }) {
  const { received, asked, tone } = offersSummary(doc);
  return (
    <span
      data-offers data-tone={tone}
      className={cn('inline-flex items-center rounded-full border px-3 py-1 text-sm font-semibold tabular-nums', PILL_TONE[tone])}
    >
      {received} מתוך {asked}
    </span>
  );
}

const DocDate = ({ iso }: { iso: string | null }) => (
  <span dir="ltr" className="tabular-nums">{formatDocDate(iso)}</span>
);

function RfqCells({ d }: { d: DocumentListItem }) {
  const unseen = d.unseen_quote_count > 0;
  const suppliers = suppliersLine(d);
  return (
    <>
      <td className={TD}>
        <div className="flex flex-col gap-1">
          <span className="font-bold text-slate-900">{d.title || '—'}</span>
          {suppliers && <span className="text-sm text-slate-500">{suppliers}</span>}
        </div>
      </td>
      <td className={cn(TD, 'text-slate-700')}>
        <span className="inline-flex flex-wrap items-center gap-2">
          <DocDate iso={d.due_date} />
          {d.due_date && !isRfqOpen(d.due_date) && (
            <span className="rounded-full bg-slate-100 px-2 py-0.5 text-xs font-semibold text-slate-600">נסגרה</span>
          )}
        </span>
      </td>
      <td className={TD}>
        <span className="inline-flex items-center gap-2">
          <OffersPill doc={d} />
          {unseen && (
            <span
              role="img" data-new-quote-tag aria-label="יש הצעה חדשה שטרם נצפתה" title="יש הצעה חדשה שטרם נצפתה"
              className="h-2.5 w-2.5 shrink-0 rounded-full bg-brand"
            />
          )}
        </span>
      </td>
      <td className={TD}>
        {d.winner_supplier_name
          ? <span className="font-bold text-slate-900">{d.winner_supplier_name}</span>
          : <span className="text-slate-400">—</span>}
      </td>
    </>
  );
}

function PoCells({ d }: { d: DocumentListItem }) {
  const total = d.subtotal + round2((d.subtotal * d.vat_rate) / 100);
  return (
    <>
      <td className={cn(TD, 'font-bold text-slate-900')}>{d.supplier_name ?? '—'}</td>
      <td className={cn(TD, 'text-slate-700')}>{d.title || '—'}</td>
      <td className={TD}><span dir="ltr" className="font-bold tabular-nums text-slate-900">{formatIls(total)}</span></td>
    </>
  );
}

export function DocumentsTable({ tab, rows, selectedId, canEdit, onSelect, onOpen, onSend, onDelete }: Props) {
  const rfq = tab === 'rfq';
  return (
    // `relative` is load-bearing: a position:absolute descendant (an sr-only label, a sticky icon) whose
    // nearest positioned ancestor is NOT this scroller escapes its clip, so on Chrome for Android the
    // layout viewport grows to the table's width and the whole page slides out of sight (the white
    // screen of /purchasing, 27/10/2026). With it the table scrolls inside the card, nothing else moves.
    <div className="relative overflow-x-auto rounded-xl border border-line bg-white shadow-soft-xs" data-table-scroll>
      <table className={cn('w-full border-collapse text-sm', rfq ? 'min-w-[980px]' : 'min-w-[840px]')} data-list={tab}>
        <thead>
          <tr className="border-b border-line bg-slate-50">
            <th className={TH}>מספר</th>
            <th className={TH}>תאריך</th>
            {rfq ? (
              <>
                <th className={TH}>נושא</th>
                <th className={TH}>יעד להגשה</th>
                <th className={TH}>הצעות</th>
                <th className={TH}>זוכה</th>
              </>
            ) : (
              <>
                <th className={TH}>ספק</th>
                <th className={TH}>תיאור</th>
                <th className={TH}>סה״כ לתשלום</th>
              </>
            )}
            <th className={cn(TH, 'text-center')}>פעולות</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((d) => (
            <tr
              key={d.id}
              data-doc={d.id}
              data-number={d.number ?? undefined}
              data-draft={d.status === 'draft' ? '' : undefined}
              data-new-quotes={d.unseen_quote_count > 0 ? d.unseen_quote_count : undefined}
              tabIndex={0}
              aria-selected={selectedId === d.id}
              onClick={() => onSelect(d.id)}
              onDoubleClick={() => onOpen(d)}
              onKeyDown={(e) => {
                if (e.target !== e.currentTarget) return;
                if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onOpen(d); }
              }}
              className={cn(
                'cursor-pointer border-b border-line transition-colors last:border-0 hover:bg-row-hover focus-visible:bg-row-hover focus-visible:outline-none',
                d.unseen_quote_count > 0 && 'bg-blue-50/60',
                selectedId === d.id && 'bg-row-hover',
              )}
            >
              <td className={cn(TD, 'font-bold tabular-nums text-slate-900')}>
                {d.status === 'draft' ? (
                  <span className="rounded-full bg-amber-100 px-2.5 py-0.5 text-xs font-bold text-amber-800">טיוטה</span>
                ) : d.number}
              </td>
              <td className={cn(TD, 'text-slate-700')}><DocDate iso={d.doc_date} /></td>
              {rfq ? <RfqCells d={d} /> : <PoCells d={d} />}
              <td className="px-2 py-2">
                <RowActions doc={d} canEdit={canEdit} onSend={onSend} onDelete={onDelete} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
