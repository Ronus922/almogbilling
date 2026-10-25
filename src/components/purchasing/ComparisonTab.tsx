'use client';

// The "השוואת הצעות" tab: one column per supplier that SUBMITTED, one row per item, the cheapest
// cell of every row and the cheapest total highlighted, the totals before / with VAT, the
// attachments and the choice of the winner. The comparison always reads the prices BEFORE VAT
// (the quote's normalised `prices`, never what the supplier typed). Choosing a winner only marks
// it; opening a purchase order from it is a separate, explicit button.

import { useMemo, useState } from 'react';
import { toast } from 'sonner';
import { Award, Paperclip, ShoppingCart } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Section } from '@/components/side-panel/Section';
import { cn } from '@/lib/utils';
import {
  cheapestLineIndex, comparisonOf, formatIls, formatQty, formatStampIL, formatStampShortIL, formatVatRate, partyKey,
  quoteTotal, withVat,
} from '@/lib/purchasing/model';
import type { DocumentDetail, PoPrefill } from './types';

interface Props {
  detail: DocumentDetail;
  canEdit: boolean;
  canCreatePo: boolean;
  onChanged: () => void;
  onCreatePo: (prefill: PoPrefill) => void;
}

const CELL = 'px-4 py-3 text-center tabular-nums';
const BEST = 'bg-emerald-50 font-bold text-emerald-700';

export function ComparisonTab({ detail, canEdit, canCreatePo, onChanged, onCreatePo }: Props) {
  const doc = detail.document;
  const quotes = useMemo(() => detail.quotes ?? [], [detail.quotes]);
  const parties = useMemo(() => {
    const keys = new Set((detail.recipients ?? []).map((r) => partyKey(r)));
    for (const q of quotes) keys.add(partyKey(q));
    return keys.size;
  }, [detail.recipients, quotes]);
  const [busy, setBusy] = useState(false);
  const cols = useMemo(() => comparisonOf(detail.lines, quotes), [detail.lines, quotes]);
  const winnerKey = doc.winner_chosen_at ? (doc.winner_manual ? doc.winner_manual_key : doc.winner_supplier_id) : null;
  const winnerQuote = quotes.find((q) => partyKey(q) === winnerKey);

  if (cols.length === 0) {
    return (
      <p className="rounded-lg border border-line bg-white p-4 text-center text-sm text-ink-3" data-comparison-empty>
        עדיין לא התקבלו הצעות להשוואה.
      </p>
    );
  }

  async function pickWinner(supplierId: string | null) {
    setBusy(true);
    try {
      const res = await fetch(`/api/purchasing/documents/${doc.id}/winner`, {
        method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ supplier_id: supplierId }),
      });
      if (!res.ok) throw new Error('winner failed');
      toast.success(supplierId ? 'ההצעה סומנה כזוכה' : 'הבחירה בוטלה');
      onChanged();
    } catch {
      toast.error('העדכון נכשל');
    } finally {
      setBusy(false);
    }
  }

  function openPo() {
    const winner = quotes.find((q) => partyKey(q) === winnerKey);
    if (!winner) return;
    const hasLines = detail.lines.every((l) => winner.prices[l.id] !== undefined);
    onCreatePo({
      supplier_id: winner.supplier_id,
      manual: winner.supplier_id
        ? null
        : { name: winner.supplier_name, phone: winner.supplier_phone ?? '', email: winner.supplier_email ?? '', address: winner.supplier_address ?? '' },
      source_rfq_id: doc.id,
      source_rfq_number: doc.number ?? 0,
      title: doc.title,
      lines: detail.lines.map((l) => ({
        description: l.description, quantity: l.quantity, unit_price: hasLines ? winner.prices[l.id]! : null,
      })),
    });
  }

  const quoteOf = (key: string) => quotes.find((q) => partyKey(q) === key);
  const cheapestTotal = cols.filter((c) => c.cheapest);

  return (
    <Section
      title="השוואת הצעות" icon={Award} iconTone="violet"
      headerSlot={<span className="text-sm font-medium text-slate-400" data-comparison-count>{cols.length} מתוך {Math.max(parties, cols.length)} ספקים הגישו</span>}
    >
      <div className="space-y-4 py-2">
        <div className="overflow-x-auto rounded-xl border border-line bg-white" data-comparison>
          <table className="w-full border-collapse text-sm" style={{ minWidth: 220 + cols.length * 170 }}>
            <thead>
              <tr className="border-b border-line bg-slate-50/80">
                <th className="px-4 py-3 text-start font-semibold text-ink-2">פריט</th>
                {cols.map((c) => (
                  <th key={c.supplier_id} className="px-4 py-3 text-center align-top">
                    <span className="flex flex-wrap items-center justify-center gap-2">
                      <span className="font-bold text-ink">{c.supplier_name}</span>
                      {c.cheapest && (
                        <span className="rounded-full border border-emerald-500 px-2 py-0.5 text-xs font-semibold text-emerald-700" data-cheapest-pill>ההצעה הזולה</span>
                      )}
                    </span>
                    <span className="mt-1 block text-xs font-normal tabular-nums text-ink-3">
                      הגיש {formatStampShortIL(quoteOf(c.supplier_id)?.updated_at)}
                    </span>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {detail.lines.map((l, i) => {
                const best = cheapestLineIndex(cols, i);
                return (
                  <tr key={l.id} className="border-b border-line" data-comparison-line={i}>
                    <td className="px-4 py-3">
                      <p className="font-semibold text-ink">{l.description}</p>
                      <p className="text-xs tabular-nums text-ink-3">כמות: {formatQty(l.quantity)}</p>
                    </td>
                    {cols.map((c, ci) => (
                      <td key={c.supplier_id} className={cn(CELL, 'font-semibold text-ink', best.includes(ci) && BEST)} dir="ltr" data-cheapest-cell={best.includes(ci) ? '' : undefined}>
                        {c.unitPrices[i] === null ? <span className="text-ink-3">—</span> : formatIls(c.unitPrices[i]!)}
                      </td>
                    ))}
                  </tr>
                );
              })}
              <tr className="border-b border-line bg-slate-50/60">
                <td className="px-4 py-3 font-bold text-ink">סה״כ (לפני מע״מ)</td>
                {cols.map((c) => (
                  <td key={c.supplier_id} className={cn(CELL, 'font-bold text-ink', c.cheapest && 'bg-emerald-100 text-emerald-700')} data-total-excl data-cheapest={c.cheapest ? '' : undefined}>
                    {c.total === null ? <span className="text-ink-3">—</span> : (
                      <>
                        <span dir="ltr">{formatIls(c.total)}</span>
                        {c.lumpSum && <span className="block text-xs font-normal text-ink-3">סכום כולל, ללא שורות</span>}
                      </>
                    )}
                  </td>
                ))}
              </tr>
              <tr className="border-b border-line bg-slate-50/60">
                <td className="px-4 py-3 text-ink-3">מע״מ {formatVatRate(doc.vat_rate)}</td>
                {cols.map((c) => (
                  <td key={c.supplier_id} className={cn(CELL, 'text-ink-3')} dir="ltr">
                    {c.total === null ? '—' : formatIls(withVat(c.total, doc.vat_rate).vat)}
                  </td>
                ))}
              </tr>
              <tr className="border-b border-line">
                <td className="px-4 py-3 font-bold text-ink">כולל מע״מ</td>
                {cols.map((c) => (
                  <td key={c.supplier_id} className={cn(CELL, 'text-base font-bold text-ink', c.cheapest && 'bg-emerald-100 text-emerald-700')} dir="ltr" data-total-incl>
                    {c.total === null ? '—' : formatIls(withVat(c.total, doc.vat_rate).total)}
                  </td>
                ))}
              </tr>
              <tr className="border-b border-line">
                <td className="px-4 py-3 text-ink-3">צרופות</td>
                {cols.map((c) => {
                  const files = quoteOf(c.supplier_id)?.files ?? [];
                  return (
                    <td key={c.supplier_id} className="px-4 py-3 text-center">
                      {files.length === 0 ? <span className="text-ink-3">—</span> : files.map((f) => (
                        <a key={f.id} href={f.url} target="_blank" rel="noopener noreferrer"
                          className="flex min-h-11 items-center justify-center gap-1.5 text-sm font-semibold text-brand hover:underline">
                          {f.original_filename} <Paperclip className="h-4 w-4 shrink-0" aria-hidden />
                        </a>
                      ))}
                    </td>
                  );
                })}
              </tr>
              <tr>
                <td className="px-4 py-3 font-bold text-ink">הצעה זוכה</td>
                {cols.map((c) => (
                  <td key={c.supplier_id} className="px-4 py-3 text-center">
                    {winnerKey === c.supplier_id ? (
                      canEdit ? (
                        <button type="button" disabled={busy} onClick={() => pickWinner(null)}
                          className="inline-flex h-11 items-center gap-2 rounded-lg bg-violet-100 px-4 text-sm font-bold text-violet-700 hover:bg-violet-200 disabled:opacity-50">
                          <Award className="h-4 w-4" aria-hidden /> זוכה · ביטול
                        </button>
                      ) : (
                        <span className="inline-flex h-11 items-center gap-2 rounded-lg bg-violet-100 px-4 text-sm font-bold text-violet-700">
                          <Award className="h-4 w-4" aria-hidden /> זוכה
                        </span>
                      )
                    ) : canEdit ? (
                      <button type="button" disabled={busy || c.total === null} onClick={() => pickWinner(c.supplier_id)} data-action="pick-winner"
                        className="inline-flex h-11 items-center gap-2 whitespace-nowrap rounded-lg border border-indigo-200 bg-indigo-50 px-3 text-sm font-semibold text-indigo-700 transition-colors hover:bg-indigo-100 disabled:opacity-50">
                        בחר כזוכה <Award className="h-4 w-4" aria-hidden />
                      </button>
                    ) : <span className="text-ink-3">—</span>}
                  </td>
                ))}
              </tr>
            </tbody>
          </table>
        </div>
        {cheapestTotal.length > 1 && (
          <p className="text-xs text-ink-3">בתיקו — כל ההצעות הזולות מסומנות.</p>
        )}

        {winnerQuote && (
          <div className="flex flex-wrap items-center gap-3 rounded-lg border border-violet-200 bg-violet-50 p-3 text-sm text-violet-900" data-winner>
            <Award className="h-4 w-4 shrink-0" aria-hidden />
            <span className="min-w-0 flex-1">
              <strong>{winnerQuote.supplier_name}</strong> נבחר כזוכה
              {doc.winner_chosen_by_name ? ` ע״י ${doc.winner_chosen_by_name}` : ''}
              {doc.winner_chosen_at ? ` · ${formatStampIL(doc.winner_chosen_at)}` : ''}
              {quoteTotal(
                detail.lines.map((l) => ({ id: l.id, description: l.description, quantity: l.quantity })),
                winnerQuote,
              ).lumpSum ? ' · ההצעה היא סכום כולל — את מחירי השורות יש להזין בהזמנה.' : ''}
            </span>
            {canEdit && canCreatePo && (
              <Button type="button" onClick={openPo} className="h-11 gap-2">
                <ShoppingCart className="h-4 w-4" /> פתח הזמנת רכש
              </Button>
            )}
          </div>
        )}
      </div>
    </Section>
  );
}
