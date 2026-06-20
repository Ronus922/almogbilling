'use client';

import { Search } from 'lucide-react';
import { Input } from '@/components/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { cn } from '@/lib/utils';
import { SUPPLIER_STATUS_FILTERS } from '@/lib/constants/suppliers';
import type { SupplierListFilters, SupplierCategory } from '@/lib/types/suppliers';

// DESIGN.md §28 suppliers toolbar — pills (start) + category pill, search (end).
export function SupplierFilters({
  filters,
  categories,
  onChange,
}: {
  filters: Required<SupplierListFilters>;
  categories: SupplierCategory[];
  onChange: (next: Partial<SupplierListFilters>) => void;
}) {
  return (
    <div className="flex flex-col gap-3 border-b border-[#eef1f6] px-[22px] py-4 md:flex-row md:items-center md:justify-between">
      {/* Filter pills + category (RTL start = right) */}
      <div className="flex flex-wrap items-center gap-2">
        {SUPPLIER_STATUS_FILTERS.map((s) => (
          <StatusPill
            key={s.value}
            label={s.label}
            active={filters.status === s.value}
            onClick={() => onChange({ status: s.value })}
          />
        ))}

        {/* Category select styled as a pill */}
        <Select
          value={filters.category}
          onValueChange={(v) => onChange({ category: v ?? 'all' })}
        >
          <SelectTrigger className="w-auto gap-1.5 rounded-full border-[#e2e8f0] bg-white px-[14px] text-[13.5px] font-semibold text-[#475569] data-[size=default]:h-9">
            <SelectValue placeholder="הכל">
              {(value: string | null) => {
                if (!value || value === 'all') return 'הכל';
                return categories.find((c) => c.id === value)?.name ?? 'קטגוריה';
              }}
            </SelectValue>
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">הכל</SelectItem>
            {categories.map((c) => (
              <SelectItem key={c.id} value={c.id}>
                {c.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      {/* Search (RTL end = left) */}
      <div className="relative w-full md:w-[300px]">
        <Search className="pointer-events-none absolute start-[13px] top-1/2 h-[17px] w-[17px] -translate-y-1/2 text-[#94a3b8]" />
        <Input
          placeholder="חיפוש לפי שם, חברה, איש קשר…"
          value={filters.search}
          onChange={(e) => onChange({ search: e.target.value })}
          className="h-10 rounded-[11px] border-[#e7ebf1] bg-[#fafbfd] ps-[42px] pe-[14px] text-[14px]"
        />
      </div>
    </div>
  );
}

function StatusPill({
  label,
  active,
  onClick,
}: {
  label: string;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'inline-flex h-9 items-center rounded-full px-4 text-[13.5px] transition-colors',
        active
          ? 'bg-[#2563eb] font-bold text-white'
          : 'border border-[#e2e8f0] bg-white font-semibold text-[#475569] hover:bg-slate-50',
      )}
    >
      {label}
    </button>
  );
}
