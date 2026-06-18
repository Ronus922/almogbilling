'use client';

import { Search } from 'lucide-react';
import { Input } from '@/components/ui/input';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select';
import type { VendorListFilters, VendorCategory } from '@/lib/types/vendors';

export function VendorFilters({
  filters,
  categories,
  onChange,
}: {
  filters: Required<VendorListFilters>;
  categories: VendorCategory[];
  onChange: (next: Partial<VendorListFilters>) => void;
}) {
  return (
    <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
      {/* Search input (icon, RTL) */}
      <div className="relative w-full md:w-72">
        <Search className="pointer-events-none absolute start-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
        <Input
          placeholder="חיפוש לפי שם, איש קשר או טלפון..."
          value={filters.search}
          onChange={(e) => onChange({ search: e.target.value })}
          className="pe-9"
        />
      </div>

      {/* Category select (dynamic, user-managed) */}
      <Select
        value={filters.category}
        onValueChange={(v) => onChange({ category: v ?? 'all' })}
      >
        <SelectTrigger className="w-full md:w-48 data-[size=default]:h-10">
          <SelectValue placeholder="כל הקטגוריות">
            {(value: string | null) => {
              if (!value || value === 'all') return 'כל הקטגוריות';
              return categories.find((c) => c.id === value)?.name ?? 'קטגוריה';
            }}
          </SelectValue>
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="all">כל הקטגוריות</SelectItem>
          {categories.map((c) => (
            <SelectItem key={c.id} value={c.id}>
              {c.name}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}
