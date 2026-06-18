'use client';

import { useCallback, useEffect, useState } from 'react';
import { Plus, Search, X } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { cn } from '@/lib/utils';
import type { Area } from '@/lib/types/areas';
import { AreaCards } from './AreaCards';
import { AreaPanel } from './AreaPanel';

export function AreasPageClient({
  canEdit,
  canDelete,
}: {
  canEdit: boolean;
  canDelete: boolean;
}) {
  const [areas, setAreas] = useState<Area[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [panelOpen, setPanelOpen] = useState(false);
  const [editing, setEditing] = useState<Area | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<Area | null>(null);
  const [deleting, setDeleting] = useState(false);

  const fetchAreas = useCallback(async () => {
    setLoading(true);
    try {
      const qs = search.trim() ? `?search=${encodeURIComponent(search.trim())}` : '';
      const res = await fetch(`/api/areas${qs}`, { credentials: 'include' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = (await res.json()) as { areas?: Area[] };
      setAreas(Array.isArray(data.areas) ? data.areas : []);
    } catch (err) {
      toast.error(`טעינת האזורים נכשלה: ${(err as Error).message}`);
      setAreas([]);
    } finally {
      setLoading(false);
    }
  }, [search]);

  useEffect(() => {
    void fetchAreas();
  }, [fetchAreas]);

  function openCreate() {
    setEditing(null);
    setPanelOpen(true);
  }

  function openEdit(area: Area) {
    setEditing(area);
    setPanelOpen(true);
  }

  async function confirmDelete() {
    if (!deleteTarget) return;
    setDeleting(true);
    try {
      const res = await fetch(`/api/areas/${deleteTarget.id}`, {
        method: 'DELETE',
        credentials: 'include',
      });
      const data = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) throw new Error(data.error ?? 'מחיקת האזור נכשלה');
      toast.success('האזור נמחק');
      setDeleteTarget(null);
      void fetchAreas();
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setDeleting(false);
    }
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
        <div className="flex items-baseline gap-3">
          <h1 className="text-2xl font-extrabold text-slate-900">ניהול אזורים</h1>
          <span className="text-sm text-muted-foreground">אזורי הבניין — חדרים סגורים ומרחבים פתוחים</span>
          <span className="inline-flex items-center justify-center rounded-full bg-slate-100 px-2 py-0.5 text-xs font-bold text-slate-600">
            {areas.length}
          </span>
        </div>

        {canEdit && (
          <Button type="button" onClick={openCreate} className="gap-2">
            <Plus className="h-4 w-4" />
            אזור חדש
          </Button>
        )}
      </div>

      <div className="space-y-4 rounded-lg bg-card p-4 border">
        {/* Search (DESIGN.md §6 clearable) */}
        <div className="relative max-w-sm">
          <Search className="pointer-events-none absolute start-3 top-1/2 h-4 w-4 -translate-y-1/2 text-ink-3" />
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="חיפוש לפי שם או תיאור..."
            className={cn('ps-9', search && 'pe-9')}
          />
          {search && (
            <button
              type="button"
              aria-label="נקה חיפוש"
              onClick={() => setSearch('')}
              className="absolute end-2 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-600"
            >
              <X className="h-4 w-4" />
            </button>
          )}
        </div>

        <AreaCards
          rows={areas}
          loading={loading}
          canEdit={canEdit}
          canDelete={canDelete}
          onEdit={openEdit}
          onDelete={setDeleteTarget}
          onCreate={openCreate}
        />
      </div>

      <AreaPanel
        open={panelOpen}
        area={editing}
        canEdit={canEdit}
        onOpenChange={setPanelOpen}
        onSaved={fetchAreas}
      />

      {/* Delete confirmation (AlertDialog only) */}
      <AlertDialog
        open={!!deleteTarget}
        onOpenChange={(o) => { if (!o && !deleting) setDeleteTarget(null); }}
      >
        <AlertDialogContent dir="rtl">
          <AlertDialogHeader>
            <AlertDialogTitle>למחוק את האזור?</AlertDialogTitle>
            <AlertDialogDescription>
              {deleteTarget
                ? `האזור "${deleteTarget.name}" יימחק לצמיתות. לא ניתן לשחזר פעולה זו.`
                : ''}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={deleting}>ביטול</AlertDialogCancel>
            <AlertDialogAction
              onClick={(e) => { e.preventDefault(); void confirmDelete(); }}
              disabled={deleting}
              className="bg-destructive text-white hover:bg-destructive/90"
            >
              {deleting ? 'מוחק…' : 'מחק'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
