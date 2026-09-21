'use client';

import { useMemo, useRef, useState } from 'react';
import { Building2, Check, Search, X } from 'lucide-react';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { cn } from '@/lib/utils';
import type { SupplierOption } from '@/lib/types/finance';

// Supplier of an expense: type to search the suppliers table (name / company /
// ח.פ. / phones) and pick one — or leave the text as a free name when the
// supplier is not in the table. Never creates a supplier. Picking sets
// supplier_id + the table's display_name; any further typing clears the id.

export interface SupplierValue {
  supplier_id: string | null;
  supplier_name: string;
}

function matches(s: SupplierOption, needle: string): boolean {
  return [s.display_name, s.company_name, s.tax_id, s.phone, s.mobile]
    .some((v) => v && v.toLowerCase().includes(needle));
}

export function SupplierSearchField({
  suppliers, value, onChange, disabled, id = 'fin-supplier',
}: {
  suppliers: SupplierOption[];
  value: SupplierValue;
  onChange: (v: SupplierValue) => void;
  disabled?: boolean;
  id?: string;
}) {
  const [open, setOpen] = useState(false);
  const blurTimer = useRef<number | null>(null);

  const needle = value.supplier_name.trim().toLowerCase();
  const results = useMemo(
    () => (needle ? suppliers.filter((s) => matches(s, needle)).slice(0, 8) : suppliers.slice(0, 8)),
    [suppliers, needle],
  );
  const showList = open && !value.supplier_id && results.length > 0;

  function pick(s: SupplierOption) {
    onChange({ supplier_id: s.id, supplier_name: s.display_name });
    setOpen(false);
  }
  function clear() {
    onChange({ supplier_id: null, supplier_name: '' });
    setOpen(false);
  }

  return (
    <div className="space-y-2">
      <Label htmlFor={id} className="text-base font-medium text-muted-foreground">ספק</Label>
      <div className="relative">
        <Search className="pointer-events-none absolute start-3 top-1/2 h-4 w-4 -translate-y-1/2 text-ink-3" />
        <Input
          id={id}
          value={value.supplier_name}
          disabled={disabled}
          autoComplete="off"
          placeholder="חיפוש ספק או שם חופשי"
          onChange={(e) => { onChange({ supplier_id: null, supplier_name: e.target.value }); setOpen(true); }}
          onFocus={() => setOpen(true)}
          onBlur={() => { blurTimer.current = window.setTimeout(() => setOpen(false), 150); }}
          onKeyDown={(e) => {
            if (e.key === 'Escape') setOpen(false);
            if (e.key === 'Enter' && showList) { e.preventDefault(); pick(results[0]); }
          }}
          className={cn('h-10 ps-9', value.supplier_name && 'pe-9')}
        />
        {value.supplier_name && !disabled && (
          <button
            type="button"
            aria-label="נקה ספק"
            onMouseDown={(e) => e.preventDefault()}
            onClick={clear}
            className="absolute end-2 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-600"
          >
            <X className="h-4 w-4" />
          </button>
        )}
        {showList && (
          <ul
            role="listbox"
            className="absolute z-20 mt-1 max-h-64 w-full overflow-y-auto rounded-md border border-slate-200 bg-white p-1 shadow-lg"
            onMouseDown={(e) => e.preventDefault()}
          >
            {results.map((s) => (
              <li key={s.id}>
                <button
                  type="button"
                  role="option"
                  aria-selected={false}
                  onClick={() => pick(s)}
                  className="flex w-full items-center gap-2 rounded-md px-2 py-2 text-start text-sm text-slate-700 transition-colors hover:bg-slate-50"
                >
                  <Building2 className="h-4 w-4 shrink-0 text-emerald-600" />
                  <span className="min-w-0 flex-1 truncate">
                    <span className="font-medium text-slate-900">{s.display_name}</span>
                    {s.company_name && s.company_name !== s.display_name && (
                      <span className="text-slate-500"> · {s.company_name}</span>
                    )}
                  </span>
                  {s.tax_id && <span className="shrink-0 font-num text-xs tabular-nums text-slate-400" dir="ltr">ח.פ. {s.tax_id}</span>}
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
      {value.supplier_id ? (
        <p className="inline-flex items-center gap-1 text-[12px] text-emerald-700"><Check className="h-3.5 w-3.5" /> ספק מרשימת הספקים</p>
      ) : value.supplier_name.trim() ? (
        <p className="text-[12px] text-slate-500 text-start">שם חופשי — הספק לא ייווצר ברשימת הספקים</p>
      ) : (
        <p className="text-[12px] text-slate-500 text-start">חיפוש לפי שם, חברה, ח.פ. או טלפון. אם הספק לא ברשימה — אפשר להקליד שם חופשי.</p>
      )}
    </div>
  );
}
