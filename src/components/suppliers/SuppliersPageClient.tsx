'use client';

import { useCallback, useEffect, useState } from 'react';
import { Plus } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import type { SupplierListItem, SupplierListFilters } from '@/lib/types/suppliers';
import { SupplierFilters } from './SupplierFilters';
import { SupplierTable } from './SupplierTable';
import { CreateSupplierPanel } from './CreateSupplierPanel';
import { SupplierDetailPanel } from './SupplierDetailPanel';

type Filters = Required<SupplierListFilters>;

const INITIAL_FILTERS: Filters = {
  search: '',
  status: 'all',
  type: 'all',
};

export function SuppliersPageClient({
  canEdit,
  canDelete,
}: {
  canEdit: boolean;
  canDelete: boolean;
}) {
  const [suppliers, setSuppliers] = useState<SupplierListItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [filters, setFilters] = useState<Filters>(INITIAL_FILTERS);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [showCreate, setShowCreate] = useState(false);

  const fetchSuppliers = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams();
      if (filters.search.trim()) params.set('search', filters.search.trim());
      if (filters.status !== 'all') params.set('status', filters.status);
      if (filters.type !== 'all') params.set('type', filters.type);
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

  useEffect(() => {
    void fetchSuppliers();
  }, [fetchSuppliers]);

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
          <Button type="button" onClick={() => setShowCreate(true)} className="gap-2">
            <Plus className="h-4 w-4" />
            ספק חדש
          </Button>
        )}
      </div>

      <div className="space-y-3 rounded-lg bg-card p-4 border">
        <SupplierFilters filters={filters} onChange={updateFilters} />
        <SupplierTable
          rows={suppliers}
          loading={loading}
          onRowClick={setSelectedId}
        />
      </div>

      <CreateSupplierPanel
        open={showCreate}
        onOpenChange={setShowCreate}
        onCreated={fetchSuppliers}
      />

      <SupplierDetailPanel
        supplierId={selectedId}
        open={!!selectedId}
        onOpenChange={(o: boolean) => {
          if (!o) setSelectedId(null);
        }}
        onChanged={fetchSuppliers}
        canEdit={canEdit}
        canDelete={canDelete}
      />
    </div>
  );
}
