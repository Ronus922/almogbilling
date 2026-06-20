'use client';

import { useCallback, useEffect, useState } from 'react';
import { Plus, FolderCog, Truck } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import type {
  SupplierListItem,
  SupplierListFilters,
  SupplierCategory,
} from '@/lib/types/suppliers';
import { SupplierFilters } from './SupplierFilters';
import { SupplierTable } from './SupplierTable';
import { CreateSupplierPanel } from './CreateSupplierPanel';
import { SupplierDetailPanel } from './SupplierDetailPanel';
import { SupplierCategoriesSheet } from './SupplierCategoriesSheet';

type Filters = Required<SupplierListFilters>;

const INITIAL_FILTERS: Filters = {
  search: '',
  status: 'active', // default load view = active suppliers only
  type: 'all',
  category: 'all',
};

export function SuppliersPageClient({
  canEdit,
  canDelete,
}: {
  canEdit: boolean;
  canDelete: boolean;
}) {
  const [suppliers, setSuppliers] = useState<SupplierListItem[]>([]);
  const [categories, setCategories] = useState<SupplierCategory[]>([]);
  const [loading, setLoading] = useState(true);
  const [filters, setFilters] = useState<Filters>(INITIAL_FILTERS);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [showCreate, setShowCreate] = useState(false);
  const [showCategories, setShowCategories] = useState(false);

  const fetchSuppliers = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams();
      if (filters.search.trim()) params.set('search', filters.search.trim());
      if (filters.status !== 'all') params.set('status', filters.status);
      if (filters.type !== 'all') params.set('type', filters.type);
      if (filters.category !== 'all') params.set('category', filters.category);
      const qs = params.toString();
      const res = await fetch(qs ? `/api/suppliers?${qs}` : '/api/suppliers', {
        credentials: 'include',
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = (await res.json()) as { suppliers?: SupplierListItem[] };
      setSuppliers(Array.isArray(data.suppliers) ? data.suppliers : []);
    } catch (err) {
      toast.error(`טעינת הספקים נכשלה: ${(err as Error).message}`);
      setSuppliers([]);
    } finally {
      setLoading(false);
    }
  }, [filters]);

  const fetchCategories = useCallback(async () => {
    try {
      const res = await fetch('/api/suppliers/categories', { credentials: 'include' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setCategories((await res.json()) as SupplierCategory[]);
    } catch (err) {
      toast.error(`טעינת הקטגוריות נכשלה: ${(err as Error).message}`);
    }
  }, []);

  useEffect(() => {
    void fetchSuppliers();
  }, [fetchSuppliers]);

  useEffect(() => {
    void fetchCategories();
  }, [fetchCategories]);

  function updateFilters(next: Partial<SupplierListFilters>) {
    setFilters((prev) => ({ ...prev, ...next }));
  }

  return (
    <div className="space-y-6">
      {/* Top bar — DESIGN.md §28 */}
      <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
        <div className="flex items-center gap-[13px]">
          <span className="grid h-12 w-12 shrink-0 place-items-center rounded-[14px] bg-[#e8f0ff] text-[#2563eb]">
            <Truck className="h-6 w-6" />
          </span>
          <div>
            <h1 className="text-[27px] font-black tracking-[-0.02em] text-[#0f172a]">ספקים</h1>
            <p className="text-[13.5px] font-medium text-[#94a3b8]">
              ניהול ספקי השירות של הבניין · {suppliers.length}
            </p>
          </div>
        </div>

        {canEdit && (
          <div className="flex items-center gap-3">
            {/* gradient CTA (RTL start = right) */}
            <Button
              type="button"
              onClick={() => setShowCreate(true)}
              className="h-[46px] gap-2 rounded-[13px] bg-gradient-to-l from-[#1d4ed8] to-[#2563eb] px-5 text-[14.5px] font-bold text-white shadow-[0_10px_22px_-8px_rgba(37,99,235,0.6)] hover:from-[#1e40af] hover:to-[#1d4ed8]"
            >
              <Plus className="h-[17px] w-[17px]" strokeWidth={2.3} />
              ספק חדש
            </Button>
            <Button
              type="button"
              variant="outline"
              onClick={() => setShowCategories(true)}
              className="h-[46px] gap-2 rounded-[13px] border-[#e2e8f0] bg-white px-[18px] text-sm font-semibold text-[#475569]"
            >
              <FolderCog className="h-4 w-4" />
              ניהול קטגוריות
            </Button>
          </div>
        )}
      </div>

      {/* Single card: toolbar (border-bottom) → table */}
      <div className="overflow-hidden rounded-[18px] border border-[#e9edf4] bg-white">
        <SupplierFilters filters={filters} categories={categories} onChange={updateFilters} />
        <SupplierTable
          rows={suppliers}
          loading={loading}
          onRowClick={setSelectedId}
        />
      </div>

      <CreateSupplierPanel
        open={showCreate}
        categories={categories}
        onOpenChange={setShowCreate}
        onCreated={fetchSuppliers}
      />

      <SupplierDetailPanel
        supplierId={selectedId}
        open={!!selectedId}
        categories={categories}
        onOpenChange={(o: boolean) => {
          if (!o) setSelectedId(null);
        }}
        onChanged={fetchSuppliers}
        canEdit={canEdit}
        canDelete={canDelete}
      />

      <SupplierCategoriesSheet
        open={showCategories}
        canEdit={canEdit}
        onOpenChange={setShowCategories}
        onChanged={async () => {
          await Promise.all([fetchCategories(), fetchSuppliers()]);
        }}
      />
    </div>
  );
}
