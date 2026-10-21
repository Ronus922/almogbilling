'use client';

// The lines table shared by both documents: פירוט · כמות · מחיר ליחידה · סה״כ
// (no SKU, no cap on the number of rows). The price columns exist only for a
// purchase order; a request for quotation carries description + quantity.
// "פירוט" completes itself from descriptions entered before.

import { useEffect, useRef, useState } from 'react';
import { Plus, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { cn } from '@/lib/utils';
import { formatIls, formatVatRate, lineTotal } from '@/lib/purchasing/model';
import { draftTotals, emptyLine, parseNumber, type LineDraft } from './lines';

interface Props {
  lines: LineDraft[];
  onChange: (next: LineDraft[]) => void;
  withPrices: boolean;
  vatRate: number;
  disabled?: boolean;
  /** Key of a row to flag (the first invalid one after a failed save). */
  errorKey?: string | null;
}

function DescriptionInput({
  id, value, onChange, disabled, invalid,
}: { id: string; value: string; onChange: (v: string) => void; disabled?: boolean; invalid?: boolean }) {
  const [options, setOptions] = useState<string[]>([]);
  const [open, setOpen] = useState(false);
  const typed = useRef(false);

  // Debounced lookup; only after the user typed (not on mount / on a pick).
  useEffect(() => {
    if (!typed.current) return;
    const t = setTimeout(async () => {
      try {
        const res = await fetch(`/api/purchasing/suggestions?q=${encodeURIComponent(value)}`, { credentials: 'include' });
        if (!res.ok) return;
        const body = await res.json();
        setOptions(Array.isArray(body.suggestions) ? body.suggestions.filter((s: string) => s !== value) : []);
      } catch { /* autocomplete is a convenience; typing continues without it */ }
    }, 180);
    return () => clearTimeout(t);
  }, [value]);

  return (
    <div className="relative">
      <Input
        id={id}
        value={value}
        disabled={disabled}
        autoComplete="off"
        aria-invalid={invalid ? true : undefined}
        placeholder="פירוט"
        onChange={(e) => { typed.current = true; onChange(e.target.value); setOpen(true); }}
        onFocus={() => { if (options.length) setOpen(true); }}
        onBlur={() => setTimeout(() => setOpen(false), 120)}
        className={cn('h-10', invalid && 'border-red-400 bg-red-50 focus-visible:ring-red-200')}
      />
      {open && options.length > 0 && (
        <ul
          role="listbox"
          className="absolute inset-x-0 top-full z-30 mt-1 max-h-52 overflow-y-auto rounded-lg border border-line bg-white p-1 shadow-lg"
        >
          {options.map((o) => (
            <li key={o} role="option" aria-selected={false}>
              <button
                type="button"
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => { typed.current = false; onChange(o); setOpen(false); }}
                className="block min-h-11 w-full rounded-md px-3 py-2 text-start text-sm text-ink hover:bg-slate-50"
              >
                {o}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export function LinesEditor({ lines, onChange, withPrices, vatRate, disabled, errorKey }: Props) {
  const set = (key: string, patch: Partial<LineDraft>) =>
    onChange(lines.map((l) => (l.key === key ? { ...l, ...patch } : l)));
  const remove = (key: string) => {
    const next = lines.filter((l) => l.key !== key);
    onChange(next.length ? next : [emptyLine()]);
  };
  const totals = draftTotals(lines, vatRate);

  // md+: description | qty | price | total | delete ; phone: one card per line.
  const grid = withPrices
    ? 'md:grid-cols-[minmax(0,1fr)_96px_128px_128px_44px]'
    : 'md:grid-cols-[minmax(0,1fr)_120px_44px]';

  return (
    <div className="space-y-3">
      <div className={cn('hidden gap-3 px-1 text-sm font-semibold text-ink-3 md:grid', grid)} aria-hidden>
        <span>פירוט</span>
        <span>כמות</span>
        {withPrices && <span>מחיר ליחידה</span>}
        {withPrices && <span>סה״כ</span>}
        <span />
      </div>

      {lines.map((l, i) => {
        const total = lineTotal({ quantity: parseNumber(l.quantity) ?? 0, unit_price: parseNumber(l.unit_price) ?? 0 });
        return (
          <div
            key={l.key}
            data-line={i}
            className={cn('grid items-start gap-3 rounded-lg border border-line bg-white p-3 md:border-0 md:bg-transparent md:p-0', grid)}
          >
            <div className="space-y-1">
              <Label htmlFor={`line-desc-${l.key}`} className="text-sm text-ink-3 md:sr-only">פירוט</Label>
              <DescriptionInput
                id={`line-desc-${l.key}`}
                value={l.description}
                onChange={(v) => set(l.key, { description: v })}
                disabled={disabled}
                invalid={errorKey === l.key}
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor={`line-qty-${l.key}`} className="text-sm text-ink-3 md:sr-only">כמות</Label>
              <Input
                id={`line-qty-${l.key}`}
                value={l.quantity}
                inputMode="decimal"
                dir="ltr"
                disabled={disabled}
                onChange={(e) => set(l.key, { quantity: e.target.value })}
                className="h-10 tabular-nums"
              />
            </div>
            {withPrices && (
              <div className="space-y-1">
                <Label htmlFor={`line-price-${l.key}`} className="text-sm text-ink-3 md:sr-only">מחיר ליחידה</Label>
                <Input
                  id={`line-price-${l.key}`}
                  value={l.unit_price}
                  inputMode="decimal"
                  dir="ltr"
                  disabled={disabled}
                  placeholder="0.00"
                  onChange={(e) => set(l.key, { unit_price: e.target.value })}
                  className="h-10 tabular-nums"
                />
              </div>
            )}
            {withPrices && (
              <div className="flex h-10 items-center text-sm font-semibold tabular-nums text-ink" dir="ltr">
                <span className="me-auto md:me-0">{formatIls(total)}</span>
              </div>
            )}
            <div className="flex justify-end md:block">
              <button
                type="button"
                onClick={() => remove(l.key)}
                disabled={disabled}
                aria-label={`מחיקת שורה ${i + 1}`}
                title="מחיקת שורה"
                className="grid h-11 w-11 place-items-center rounded-lg text-ink-3 transition-colors hover:bg-rose-50 hover:text-rose-600 disabled:opacity-50"
              >
                <Trash2 className="h-4 w-4" />
              </button>
            </div>
          </div>
        );
      })}

      <Button
        type="button"
        variant="outline"
        disabled={disabled}
        onClick={() => onChange([...lines, emptyLine()])}
        className="h-11 gap-2"
      >
        <Plus className="h-4 w-4" />
        הוספת שורה
      </Button>

      {withPrices && (
        <dl className="ms-auto w-full max-w-xs space-y-2 rounded-lg border border-line bg-white p-4 text-sm" data-totals>
          <div className="flex items-center justify-between gap-4">
            <dt className="text-ink-2">סה״כ</dt>
            <dd className="font-semibold tabular-nums" dir="ltr">{formatIls(totals.subtotal)}</dd>
          </div>
          <div className="flex items-center justify-between gap-4">
            <dt className="text-ink-2">מע״מ {formatVatRate(vatRate)}</dt>
            <dd className="font-semibold tabular-nums" dir="ltr">{formatIls(totals.vat)}</dd>
          </div>
          <div className="flex items-center justify-between gap-4 border-t border-line pt-2 text-base">
            <dt className="font-bold text-ink">סה״כ לתשלום</dt>
            <dd className="font-bold tabular-nums text-ink" dir="ltr">{formatIls(totals.total)}</dd>
          </div>
        </dl>
      )}
    </div>
  );
}
