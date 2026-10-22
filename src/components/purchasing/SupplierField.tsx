'use client';

// The one supplier field of the purchasing form: type to search the suppliers
// list, pick one — or just keep typing a name that is not in the list. Picking
// sets `supplierId`; editing the text afterwards drops the pick (the text is
// then a hand-typed supplier).

import { useMemo, useState } from 'react';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { cn } from '@/lib/utils';
import type { SupplierBrief } from './types';

interface Props {
  id: string;
  text: string;
  supplierId: string | null;
  suppliers: SupplierBrief[];
  onChange: (next: { text: string; supplierId: string | null }) => void;
  error?: string | null;
  disabled?: boolean;
}

export function SupplierField({ id, text, supplierId, suppliers, onChange, error, disabled }: Props) {
  const [open, setOpen] = useState(false);

  const options = useMemo(() => {
    const q = text.trim().toLowerCase();
    const hits = q
      ? suppliers.filter((s) => `${s.name} ${s.email} ${s.phone} ${s.mobile}`.toLowerCase().includes(q))
      : suppliers;
    return hits.slice(0, 8);
  }, [suppliers, text]);

  return (
    <div className="space-y-2">
      <Label htmlFor={id} className="text-base font-medium text-muted-foreground">
        ספק<span className="text-red-500"> *</span>
      </Label>
      <div className="relative">
        <Input
          id={id}
          value={text}
          disabled={disabled}
          autoComplete="off"
          aria-invalid={error ? true : undefined}
          placeholder="חיפוש ספק מהרשימה או הקלדת שם ספק"
          onChange={(e) => { onChange({ text: e.target.value, supplierId: null }); setOpen(true); }}
          onFocus={() => setOpen(true)}
          onBlur={() => setTimeout(() => setOpen(false), 120)}
          className={cn('h-10', error && 'border-red-400 bg-red-50 focus-visible:ring-red-200')}
        />
        {open && options.length > 0 && !(supplierId && options.length === 1 && options[0].id === supplierId) && (
          <ul
            role="listbox"
            className="absolute inset-x-0 top-full z-30 mt-1 max-h-60 overflow-y-auto rounded-lg border border-line bg-white p-1 shadow-lg"
          >
            {options.map((s) => (
              <li key={s.id} role="option" aria-selected={s.id === supplierId}>
                <button
                  type="button"
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => { onChange({ text: s.name, supplierId: s.id }); setOpen(false); }}
                  className="block min-h-11 w-full rounded-md px-3 py-2 text-start text-sm text-ink hover:bg-slate-50"
                >
                  {s.name}
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
      {error && <p className="text-[12px] font-semibold text-red-500 text-start">⚠️ {error}</p>}
      {!error && !supplierId && text.trim() && (
        <p className="text-[12px] text-slate-500">ספק שאינו ברשימה — הפרטים נשמרים על המסמך בלבד.</p>
      )}
    </div>
  );
}
