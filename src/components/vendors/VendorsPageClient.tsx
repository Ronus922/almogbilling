'use client';

import { useCallback, useEffect, useState } from 'react';
import { Plus, FolderCog, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import type {
  VendorListItem, VendorListFilters, VendorCategory,
} from '@/lib/types/vendors';
import { VendorFilters } from './VendorFilters';
import { VendorTable } from './VendorTable';
import { VendorPanel } from './VendorPanel';
import { VendorCategoriesSheet } from './VendorCategoriesSheet';

type Filters = Required<VendorListFilters>;

const INITIAL_FILTERS: Filters = { search: '', category: 'all' };

export function VendorsPageClient({ canEdit }: { canEdit: boolean }) {
  const [vendors, setVendors] = useState<VendorListItem[]>([]);
  const [categories, setCategories] = useState<VendorCategory[]>([]);
  const [loading, setLoading] = useState(true);
  const [filters, setFilters] = useState<Filters>(INITIAL_FILTERS);

  const [panelOpen, setPanelOpen] = useState(false);
  const [editId, setEditId] = useState<string | null>(null);
  const [showCategories, setShowCategories] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<VendorListItem | null>(null);
  const [deleting, setDeleting] = useState(false);

  const fetchVendors = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams();
      if (filters.search.trim()) params.set('search', filters.search.trim());
      if (filters.category !== 'all') params.set('category', filters.category);
      const qs = params.toString();
      const res = await fetch(qs ? `/api/vendors?${qs}` : '/api/vendors', {
        credentials: 'include',
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = (await res.json()) as { vendors?: VendorListItem[] };
      setVendors(Array.isArray(data.vendors) ? data.vendors : []);
    } catch (err) {
      toast.error(`טעינת הספקים נכשלה: ${(err as Error).message}`);
      setVendors([]);
    } finally {
      setLoading(false);
    }
  }, [filters]);

  const fetchCategories = useCallback(async () => {
    try {
      const res = await fetch('/api/vendors/categories', { credentials: 'include' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setCategories((await res.json()) as VendorCategory[]);
    } catch (err) {
      toast.error(`טעינת הקטגוריות נכשלה: ${(err as Error).message}`);
    }
  }, []);

  useEffect(() => { void fetchVendors(); }, [fetchVendors]);
  useEffect(() => { void fetchCategories(); }, [fetchCategories]);

  function updateFilters(next: Partial<VendorListFilters>) {
    setFilters((prev) => ({ ...prev, ...next }));
  }

  function openCreate() {
    setEditId(null);
    setPanelOpen(true);
  }

  function openEdit(id: string) {
    setEditId(id);
    setPanelOpen(true);
  }

  async function confirmDelete() {
    if (!deleteTarget) return;
    setDeleting(true);
    try {
      const res = await fetch(`/api/vendors/${deleteTarget.id}`, {
        method: 'DELETE',
        credentials: 'include',
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error || `HTTP ${res.status}`);
      }
      toast.success('הספק נמחק');
      setDeleteTarget(null);
      await fetchVendors();
    } catch (err) {
      toast.error(`מחיקה נכשלה: ${(err as Error).message}`);
    } finally {
      setDeleting(false);
    }
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
        <div className="flex items-baseline gap-3">
          <h1 className="text-2xl font-extrabold text-slate-900">ספקים</h1>
          <span className="text-sm text-muted-foreground">ספריית ספקי השירות של הבניין</span>
          <span className="inline-flex items-center justify-center rounded-full bg-slate-100 px-2 py-0.5 text-xs font-bold text-slate-600">
            {vendors.length}
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
            <Button type="button" onClick={openCreate} className="gap-2">
              <Plus className="h-4 w-4" />
              ספק חדש
            </Button>
          </div>
        )}
      </div>

      <div className="space-y-3 rounded-lg bg-card p-4 border">
        <VendorFilters filters={filters} categories={categories} onChange={updateFilters} />
        <VendorTable
          rows={vendors}
          loading={loading}
          canEdit={canEdit}
          onRowClick={openEdit}
          onDelete={setDeleteTarget}
        />
      </div>

      <VendorPanel
        open={panelOpen}
        vendorId={editId}
        categories={categories}
        onOpenChange={setPanelOpen}
        onSaved={fetchVendors}
      />

      <VendorCategoriesSheet
        open={showCategories}
        canEdit={canEdit}
        onOpenChange={setShowCategories}
        onChanged={async () => {
          await Promise.all([fetchCategories(), fetchVendors()]);
        }}
      />

      {/* Delete vendor confirm (soft) */}
      <AlertDialog open={deleteTarget !== null} onOpenChange={(v) => { if (!v) setDeleteTarget(null); }}>
        <AlertDialogContent dir="rtl">
          <AlertDialogHeader>
            <AlertDialogTitle>מחיקת ספק</AlertDialogTitle>
            <AlertDialogDescription>
              האם למחוק את{' '}
              <strong className="font-semibold text-slate-900">
                &quot;{deleteTarget?.name ?? ''}&quot;
              </strong>
              ? הספק יוסר מהרשימה.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={deleting}>ביטול</AlertDialogCancel>
            <AlertDialogAction
              onClick={confirmDelete}
              disabled={deleting}
              className="gap-2 bg-destructive text-white hover:bg-destructive/90"
            >
              <Trash2 className="h-4 w-4" />
              מחק
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
