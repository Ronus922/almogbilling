'use client';

// The quotes of a request: who it was sent to (and whether they opened their
// link / submitted), the side-by-side comparison, the choice of the winner and
// the shortcut to open a purchase order from it. There is no approval flow —
// the system records who chose, and when.

import { useMemo, useState } from 'react';
import { toast } from 'sonner';
import { Award, Copy, ExternalLink, FileText, ShoppingCart, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Section } from '@/components/side-panel/Section';
import { cn } from '@/lib/utils';
import {
  buildComparison, cheapestLineIndex, computeTotals, formatDocDate, formatIls, formatQty, formatStampIL,
  formatVatRate, MANUAL_PARTY, partyKey, quoteTotal, type CompareLine,
} from '@/lib/purchasing/model';
import type { DocumentDetail, PoPrefill, QuoteView } from './types';

interface Props {
  detail: DocumentDetail;
  canEdit: boolean;
  onChanged: () => void;
  onCreatePo: (prefill: PoPrefill) => void;
}

export function QuotesSection({ detail, canEdit, onChanged, onCreatePo }: Props) {
  const doc = detail.document;
  const quotes = useMemo(() => detail.quotes ?? [], [detail.quotes]);
  const recipients = detail.recipients ?? [];
  const [busy, setBusy] = useState(false);

  const lines: CompareLine[] = detail.lines.map((l) => ({ id: l.id, description: l.description, quantity: l.quantity }));
  const cols = useMemo(
    () => buildComparison(lines, quotes.map((q) => ({
      supplier_id: partyKey(q), supplier_name: q.supplier_name, prices: q.prices, total_amount: q.total_amount,
    }))),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `lines` is derived from detail.lines
    [detail.lines, quotes],
  );

  async function copyLink(link: string) {
    try {
      await navigator.clipboard.writeText(link);
      toast.success('הקישור הועתק');
    } catch {
      toast.error('ההעתקה נכשלה');
    }
  }

  // A party is a listed supplier's uuid, or MANUAL_PARTY for the request's hand-typed supplier.
  const winnerKey = doc.winner_chosen_at ? (doc.winner_manual ? MANUAL_PARTY : doc.winner_supplier_id) : null;

  async function pickWinner(supplierId: string | null) {
    setBusy(true);
    try {
      const res = await fetch(`/api/purchasing/documents/${doc.id}/winner`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ supplier_id: supplierId }),
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

  async function removeQuote(q: QuoteView) {
    if (!window.confirm(`למחוק את ההצעה של ${q.supplier_name}?`)) return;
    setBusy(true);
    try {
      const res = await fetch(`/api/purchasing/documents/${doc.id}/quotes?supplier_id=${partyKey(q)}`, { method: 'DELETE' });
      if (!res.ok) throw new Error('delete failed');
      onChanged();
    } catch {
      toast.error('המחיקה נכשלה');
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
        : { name: winner.supplier_name, phone: doc.supplier_phone ?? '', email: doc.supplier_email ?? '', address: doc.supplier_address ?? '' },
      source_rfq_id: doc.id,
      source_rfq_number: doc.number ?? 0,
      title: doc.title,
      lines: detail.lines.map((l) => ({
        description: l.description, quantity: l.quantity, unit_price: hasLines ? winner.prices[l.id]! : null,
      })),
    });
  }

  const supplierRows = [
    ...recipients.map((r) => ({
      supplier_id: partyKey(r), name: r.supplier_name, link: r.link,
      viewed: r.last_viewed_at, quote: quotes.find((q) => partyKey(q) === partyKey(r)) ?? null,
    })),
    ...quotes
      .filter((q) => !recipients.some((r) => partyKey(r) === partyKey(q)))
      .map((q) => ({ supplier_id: partyKey(q), name: q.supplier_name, link: null as string | null, viewed: null as string | null, quote: q })),
  ];

  const winnerQuote = quotes.find((q) => partyKey(q) === winnerKey);

  return (
    <>
      <Section title="ספקים והצעות" icon={ShoppingCart} iconTone="blue">
        <div className="space-y-2 py-2" data-recipients>
          {supplierRows.length === 0 && (
            <p className="rounded-lg border border-line bg-white p-4 text-center text-sm text-ink-3">
              הבקשה טרם נשלחה לספקים. לחצו על &quot;שליחה&quot; כדי לשלוח.
            </p>
          )}
          {supplierRows.map((r) => (
            <div key={r.supplier_id} className="rounded-lg border border-line bg-white p-3" data-recipient={r.supplier_id}>
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                <span className="text-sm font-semibold text-ink">{r.name}</span>
                {r.quote ? (
                  <span className="rounded-full bg-emerald-50 px-2.5 py-0.5 text-xs font-semibold text-emerald-700">
                    הוגשה בקישור · {formatStampIL(r.quote.updated_at)}
                  </span>
                ) : r.viewed ? (
                  <span className="rounded-full bg-amber-50 px-2.5 py-0.5 text-xs font-semibold text-amber-700">נפתח {formatStampIL(r.viewed)}</span>
                ) : (
                  <span className="rounded-full bg-slate-100 px-2.5 py-0.5 text-xs font-semibold text-slate-600">טרם נפתח</span>
                )}
                {winnerKey === r.supplier_id && (
                  <span className="inline-flex items-center gap-1 rounded-full bg-violet-100 px-2.5 py-0.5 text-xs font-bold text-violet-700">
                    <Award className="h-3 w-3" aria-hidden /> זוכה
                  </span>
                )}
                <span className="ms-auto flex flex-wrap items-center gap-1">
                  {r.link && (
                    <>
                      <button type="button" onClick={() => copyLink(r.link!)} title="העתקת הקישור האישי" aria-label={`העתקת הקישור של ${r.name}`}
                        className="inline-flex h-11 items-center gap-1 rounded-lg px-3 text-sm font-semibold text-ink-2 hover:bg-slate-100">
                        <Copy className="h-4 w-4" /> קישור
                      </button>
                      <a href={r.link} target="_blank" rel="noopener noreferrer" title="פתיחה כספק" aria-label={`פתיחת הקישור של ${r.name}`}
                        className="grid h-11 w-11 place-items-center rounded-lg text-ink-3 hover:bg-slate-100">
                        <ExternalLink className="h-4 w-4" />
                      </a>
                    </>
                  )}
                  {canEdit && r.quote && (
                    <button type="button" disabled={busy} onClick={() => removeQuote(r.quote!)} aria-label={`מחיקת ההצעה של ${r.name}`}
                      className="grid h-11 w-11 place-items-center rounded-lg text-ink-3 hover:bg-rose-50 hover:text-rose-600 disabled:opacity-50">
                      <Trash2 className="h-4 w-4" />
                    </button>
                  )}
                </span>
              </div>
              {r.quote && (r.quote.files.length > 0 || r.quote.notes || r.quote.valid_until) && (
                <div className="mt-2 space-y-1 border-t border-line pt-2 text-xs text-ink-2">
                  {r.quote.valid_until && <p>תוקף ההצעה: <span className="tabular-nums">{formatDocDate(r.quote.valid_until)}</span></p>}
                  {r.quote.notes && <p className="whitespace-pre-wrap">הערות: {r.quote.notes}</p>}
                  {r.quote.files.map((f) => (
                    <a key={f.id} href={f.url} target="_blank" rel="noopener noreferrer" className="flex items-center gap-2 font-semibold text-brand hover:underline">
                      <FileText className="h-3.5 w-3.5" aria-hidden /> {f.original_filename}
                    </a>
                  ))}
                </div>
              )}
            </div>
          ))}
        </div>
      </Section>

      {cols.length > 0 && (
        <Section title="השוואת הצעות" icon={Award} iconTone="violet">
          <div className="space-y-4 py-2">
            <div className="overflow-x-auto rounded-xl border border-line bg-white" data-comparison>
              <table className="w-full min-w-[520px] border-collapse text-sm">
                <thead>
                  <tr className="border-b border-line bg-slate-50/80">
                    <th className="px-4 py-3 text-start font-semibold text-ink-2">פריט</th>
                    {cols.map((c) => (
                      <th key={c.supplier_id} className="px-4 py-3 text-start font-semibold text-ink-2">{c.supplier_name}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {detail.lines.map((l, i) => {
                    const best = cheapestLineIndex(cols, i);
                    return (
                      <tr key={l.id} className="border-b border-line last:border-0">
                        <td className="px-4 py-3">
                          <p className="font-semibold text-ink">{l.description}</p>
                          <p className="text-xs tabular-nums text-ink-3">כמות: {formatQty(l.quantity)}</p>
                        </td>
                        {cols.map((c, ci) => (
                          <td key={c.supplier_id} className={cn('px-4 py-3 tabular-nums', best.includes(ci) && 'bg-emerald-50')}>
                            {c.unitPrices[i] === null ? (
                              <span className="text-ink-3">—</span>
                            ) : (
                              <>
                                <p className="font-semibold text-ink" dir="ltr">{formatIls(c.unitPrices[i]!)}</p>
                                <p className="text-xs text-ink-3" dir="ltr">{formatIls(c.lineTotals[i]!)}</p>
                              </>
                            )}
                          </td>
                        ))}
                      </tr>
                    );
                  })}
                  <tr className="border-t border-line bg-slate-50/80">
                    <td className="px-4 py-3 font-bold text-ink">סה״כ (לפני מע״מ)</td>
                    {cols.map((c) => (
                      <td key={c.supplier_id} className={cn('px-4 py-3 tabular-nums', c.cheapest && 'bg-emerald-100')}>
                        {c.total === null ? <span className="text-ink-3">—</span> : (
                          <>
                            <p className="font-bold text-ink" dir="ltr">{formatIls(c.total)}</p>
                            {c.lumpSum && <p className="text-xs text-ink-3">סכום כולל, ללא שורות</p>}
                            {c.cheapest && <p className="mt-1 inline-block rounded-full bg-emerald-600 px-2 py-0.5 text-xs font-bold text-white">הזול ביותר</p>}
                          </>
                        )}
                      </td>
                    ))}
                  </tr>
                  <tr className="border-t border-line">
                    <td className="px-4 py-3 text-ink-2">כולל מע״מ {formatVatRate(doc.vat_rate)}</td>
                    {cols.map((c) => (
                      <td key={c.supplier_id} className="px-4 py-3 tabular-nums text-ink-2" dir="ltr">
                        {c.total === null ? '—' : formatIls(computeTotals([{ quantity: 1, unit_price: c.total }], doc.vat_rate).total)}
                      </td>
                    ))}
                  </tr>
                  {canEdit && (
                    <tr className="border-t border-line">
                      <td className="px-4 py-3 text-ink-2">הצעה זוכה</td>
                      {cols.map((c) => (
                        <td key={c.supplier_id} className="px-4 py-3">
                          {winnerKey === c.supplier_id ? (
                            <button type="button" disabled={busy} onClick={() => pickWinner(null)}
                              className="inline-flex h-11 items-center gap-1 rounded-lg bg-violet-100 px-3 text-sm font-bold text-violet-700 hover:bg-violet-200 disabled:opacity-50">
                              <Award className="h-4 w-4" aria-hidden /> זוכה · ביטול
                            </button>
                          ) : (
                            <button type="button" disabled={busy || c.total === null} onClick={() => pickWinner(c.supplier_id)}
                              className="inline-flex h-11 items-center rounded-lg border border-line px-3 text-sm font-semibold text-ink-2 hover:bg-slate-50 disabled:opacity-50">
                              בחר כזוכה
                            </button>
                          )}
                        </td>
                      ))}
                    </tr>
                  )}
                </tbody>
              </table>
            </div>

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
                {canEdit && (
                  <Button type="button" onClick={openPo} className="h-11 gap-2">
                    <ShoppingCart className="h-4 w-4" /> פתח הזמנת רכש
                  </Button>
                )}
              </div>
            )}
          </div>
        </Section>
      )}
    </>
  );
}
