'use client';

import { useCallback, useEffect, useState } from 'react';
import { Plus, FolderCog } from 'lucide-react';
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
  status: 'all',
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
      {/* Header */}
      <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
        <div className="flex items-baseline gap-3">
          <h1 className="text-2xl font-extrabold text-slate-900">ספקים</h1>
          <span className="text-sm text-muted-foreground">ניהול ספקי השירות של הבניין</span>
          <span className="inline-flex items-center justify-center rounded-full bg-slate-100 px-2 py-0.5 text-xs font-bold text-slate-600">
            {suppliers.length}
          </span>
        </div>

        {canEdit && (
          <div className="flex items-center gap-2">
            <Button
              type="button"
              variant="outline"
              onClick={() => setShowCategories(true)}
              className="gap-2"
            >
              <FolderCog className="h-4 w-4" />
              ניהול קטגוריות
            </Button>
            <Button type="button" onClick={() => setShowCreate(true)} className="gap-2">
              <Plus className="h-4 w-4" />
              ספק חדש
            </Button>
          </div>
        )}
      </div>

      <div className="space-y-3 rounded-lg bg-card p-4 border">
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
