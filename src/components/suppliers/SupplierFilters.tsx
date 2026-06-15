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
    <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
      {/* Search input (icon, RTL) */}
      <div className="relative w-full md:w-64">
        <Search className="pointer-events-none absolute start-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
        <Input
          placeholder="חיפוש לפי שם, חברה, איש קשר..."
          value={filters.search}
          onChange={(e) => onChange({ search: e.target.value })}
          className="pe-9"
        />
      </div>

      <div className="flex flex-wrap items-center gap-2">
        {/* Status filter pills */}
        <div className="flex flex-wrap items-center gap-1.5">
          <StatusPill
            label="הכל"
            active={filters.status === 'all'}
            onClick={() => onChange({ status: 'all' })}
          />
          {SUPPLIER_STATUS_FILTERS.map((s) => (
            <StatusPill
              key={s.value}
              label={s.label}
              active={filters.status === s.value}
              onClick={() => onChange({ status: s.value })}
            />
          ))}
        </div>

        {/* Category select (dynamic, user-managed) */}
        <Select
          value={filters.category}
          onValueChange={(v) => onChange({ category: v ?? 'all' })}
        >
          <SelectTrigger className="w-44">
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
        'inline-flex items-center rounded-full border px-3 py-1 text-sm font-medium transition-colors',
        active
          ? 'border-blue-600 bg-blue-600 text-white'
          : 'border-slate-200 bg-white text-slate-600 hover:bg-slate-50',
      )}
    >
      {label}
    </button>
  );
}
