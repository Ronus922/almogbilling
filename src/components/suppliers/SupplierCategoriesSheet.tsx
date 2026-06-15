'use client';

import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { Plus, Pencil, Trash2, Check, X, FolderCog } from 'lucide-react';
import { Sheet, SheetContent, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { Section } from '@/components/side-panel/Section';
import { cn } from '@/lib/utils';
import type { SupplierCategoryWithCount } from '@/lib/types/suppliers';
import { useEscapeKey } from '@/lib/hooks/useEscapeKey';

export function SupplierCategoriesSheet({
  open,
  canEdit,
  onOpenChange,
  onChanged,
}: {
  open: boolean;
  canEdit: boolean;
  onOpenChange: (v: boolean) => void;
  /** Called after any successful mutation so the parent can refresh. */
  onChanged: () => void | Promise<void>;
}) {
  const [rows, setRows] = useState<SupplierCategoryWithCount[]>([]);
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState<string | null>(null);

  const [newName, setNewName] = useState('');
  const [adding, setAdding] = useState(false);

  const [editingId, setEditingId] = useState<string | null>(null);
  const [editName, setEditName] = useState('');

  const [deleteTarget, setDeleteTarget] = useState<SupplierCategoryWithCount | null>(null);

  useEscapeKey(open && deleteTarget === null && editingId === null, () => onOpenChange(false));

  async function refetch() {
    try {
      const res = await fetch('/api/suppliers/categories?scope=all', { credentials: 'include' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setRows((await res.json()) as SupplierCategoryWithCount[]);
    } catch (err) {
      toast.error(`טעינת הקטגוריות נכשלה: ${(err as Error).message}`);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    if (open) {
      setLoading(true);
      setNewName('');
      setEditingId(null);
      void refetch();
    }
  }, [open]);

  async function addCategory() {
    const name = newName.trim();
    if (!name || adding) return;
    setAdding(true);
    try {
      const res = await fetch('/api/suppliers/categories', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ name }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        toast.error(body.message || body.errors?.name || `הוספה נכשלה: HTTP ${res.status}`);
        return;
      }
      toast.success('הקטגוריה נוספה');
      setNewName('');
      await refetch();
      await onChanged();
    } catch (err) {
      toast.error(`הוספה נכשלה: ${(err as Error).message}`);
    } finally {
      setAdding(false);
    }
  }

  async function saveRename(id: string) {
    const name = editName.trim();
    if (!name) return;
    setBusyId(id);
    try {
      const res = await fetch(`/api/suppliers/categories/${id}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ name }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        toast.error(body.message || body.errors?.name || `שמירה נכשלה: HTTP ${res.status}`);
        return;
      }
      toast.success('השם עודכן');
      setEditingId(null);
      await refetch();
      await onChanged();
    } catch (err) {
      toast.error(`שמירה נכשלה: ${(err as Error).message}`);
    } finally {
      setBusyId(null);
    }
  }

  async function toggleActive(cat: SupplierCategoryWithCount, next: boolean) {
    setBusyId(cat.id);
    const prev = rows;
    setRows((rs) => rs.map((r) => (r.id === cat.id ? { ...r, is_active: next } : r)));
    try {
      const res = await fetch(`/api/suppliers/categories/${cat.id}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ is_active: next }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.message || `HTTP ${res.status}`);
      }
      toast.success(next ? 'הקטגוריה הופעלה' : 'הקטגוריה הושבתה');
      await onChanged();
    } catch (err) {
      setRows(prev);
      toast.error((err as Error).message);
    } finally {
      setBusyId(null);
    }
  }

  async function confirmDelete() {
    if (!deleteTarget) return;
    setBusyId(deleteTarget.id);
    try {
      const res = await fetch(`/api/suppliers/categories/${deleteTarget.id}`, {
        method: 'DELETE',
        credentials: 'include',
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        toast.error(body.message || `מחיקה נכשלה: HTTP ${res.status}`);
        return;
      }
      toast.success('הקטגוריה נמחקה');
      setDeleteTarget(null);
      await refetch();
      await onChanged();
    } catch (err) {
      toast.error(`מחיקה נכשלה: ${(err as Error).message}`);
    } finally {
      setBusyId(null);
    }
  }

  return (
    <>
      <Sheet open={open} onOpenChange={onOpenChange}>
        <SheetContent
          side="left"
          dir="rtl"
          showCloseButton={false}
          className="w-full p-0 sm:w-[55vw] md:min-w-[640px] flex flex-col gap-0 overflow-hidden bg-white"
        >
          {/* Header — site panel gradient (matches Create/Detail supplier panels) */}
          <SheetHeader className="flex-none gap-2 bg-gradient-to-bl from-slate-900 via-blue-950 to-blue-900 px-6 py-6 text-white">
            <div className="flex items-start justify-between gap-4">
              <div className="min-w-0 flex-1">
                <SheetTitle className="text-2xl font-bold text-white">ניהול קטגוריות</SheetTitle>
                <p className="mt-1 text-sm text-white/70">
                  הוספה, שינוי שם, השבתה ומחיקה של קטגוריות הספקים.
                </p>
              </div>
              <button
                type="button"
                onClick={() => onOpenChange(false)}
                aria-label="סגור"
                className="flex h-11 w-11 shrink-0 items-center justify-center rounded-lg border border-white/25 bg-white/5 text-white transition-colors hover:bg-white/15 hover:border-white/50"
              >
                <X className="h-5 w-5" />
              </button>
            </div>
          </SheetHeader>

          {/* Body */}
          <div className="flex-1 overflow-y-auto bg-slate-50/60 p-5">
            <Section title="קטגוריות" icon={FolderCog} iconTone="blue">
              <div className="space-y-3 py-2">
                {/* Add row */}
                {canEdit && (
                  <div className="flex items-center gap-2 border-b border-slate-100 pb-3">
                    <Input
                      value={newName}
                      onChange={(e) => setNewName(e.target.value)}
                      onKeyDown={(e) => { if (e.key === 'Enter') void addCategory(); }}
                      placeholder="שם קטגוריה חדשה..."
                      className="h-10"
                    />
                    <Button
                      type="button"
                      onClick={addCategory}
                      disabled={adding || newName.trim() === ''}
                      className="shrink-0 gap-2"
                    >
                      <Plus className="h-4 w-4" />
                      הוסף
                    </Button>
                  </div>
                )}

                {/* List */}
                {loading ? (
                  <div className="space-y-2">
                    <div className="h-11 rounded-lg bg-slate-100 animate-pulse" />
                    <div className="h-11 rounded-lg bg-slate-100 animate-pulse" />
                    <div className="h-11 rounded-lg bg-slate-100 animate-pulse" />
                  </div>
                ) : rows.length === 0 ? (
                  <div className="flex flex-col items-center justify-center gap-3 py-10 text-center">
                    <span className="grid h-12 w-12 place-items-center rounded-full bg-blue-50 text-blue-600">
                      <FolderCog className="h-5 w-5" />
                    </span>
                    <p className="text-sm text-muted-foreground">טרם הוגדרו קטגוריות.</p>
                  </div>
                ) : (
                  <ul className="divide-y divide-slate-100">
                    {rows.map((cat) => {
                      const isEditing = editingId === cat.id;
                      const rowBusy = busyId === cat.id;
                      const blocked = cat.linked_count > 0;
                      return (
                        <li
                          key={cat.id}
                          className={cn(
                            'flex items-center gap-3 py-2.5',
                            !cat.is_active && 'opacity-60',
                          )}
                        >
                          {isEditing ? (
                            <>
                              <Input
                                value={editName}
                                onChange={(e) => setEditName(e.target.value)}
                                onKeyDown={(e) => {
                                  if (e.key === 'Enter') void saveRename(cat.id);
                                  if (e.key === 'Escape') setEditingId(null);
                                }}
                                autoFocus
                                className="h-9"
                              />
                              <Button
                                type="button"
                                variant="ghost"
                                size="icon"
                                onClick={() => saveRename(cat.id)}
                                disabled={rowBusy || editName.trim() === ''}
                                aria-label="שמור"
                                className="shrink-0 text-emerald-600 hover:text-emerald-700"
                              >
                                <Check className="h-4 w-4" />
                              </Button>
                              <Button
                                type="button"
                                variant="ghost"
                                size="icon"
                                onClick={() => setEditingId(null)}
                                disabled={rowBusy}
                                aria-label="ביטול"
                                className="shrink-0"
                              >
                                <X className="h-4 w-4" />
                              </Button>
                            </>
                          ) : (
                            <>
                              <span className="flex-1 truncate text-sm font-semibold text-slate-900">
                                {cat.name}
                              </span>
                              <span className="shrink-0 rounded-full bg-slate-100 px-2 py-0.5 text-xs font-medium text-slate-500 tabular-nums">
                                {cat.linked_count} ספקים
                              </span>
                              {canEdit && (
                                <div className="flex shrink-0 items-center gap-1">
                                  <Tooltip>
                                    <TooltipTrigger render={<span className="inline-flex" />}>
                                      <Switch
                                        checked={cat.is_active}
                                        disabled={rowBusy}
                                        onCheckedChange={(v) => toggleActive(cat, v)}
                                        aria-label={cat.is_active ? 'השבת קטגוריה' : 'הפעל קטגוריה'}
                                      />
                                    </TooltipTrigger>
                                    <TooltipContent>{cat.is_active ? 'פעילה' : 'מושבתת'}</TooltipContent>
                                  </Tooltip>
                                  <Button
                                    type="button"
                                    variant="ghost"
                                    size="icon"
                                    onClick={() => { setEditingId(cat.id); setEditName(cat.name); }}
                                    disabled={rowBusy}
                                    aria-label="עריכת שם"
                                  >
                                    <Pencil className="h-4 w-4" />
                                  </Button>
                                  {blocked ? (
                                    <Tooltip>
                                      <TooltipTrigger render={<span className="inline-flex" />}>
                                        <Button
                                          type="button"
                                          variant="ghost"
                                          size="icon"
                                          disabled
                                          aria-label="לא ניתן למחוק"
                                          className="text-slate-300"
                                        >
                                          <Trash2 className="h-4 w-4" />
                                        </Button>
                                      </TooltipTrigger>
                                      <TooltipContent>משויכים ספקים — לא ניתן למחוק</TooltipContent>
                                    </Tooltip>
                                  ) : (
                                    <Tooltip>
                                      <TooltipTrigger render={<span className="inline-flex" />}>
                                        <Button
                                          type="button"
                                          variant="ghost"
                                          size="icon"
                                          onClick={() => setDeleteTarget(cat)}
                                          disabled={rowBusy}
                                          aria-label="מחיקה"
                                          className="text-red-500 hover:text-red-600"
                                        >
                                          <Trash2 className="h-4 w-4" />
                                        </Button>
                                      </TooltipTrigger>
                                      <TooltipContent>מחיקה</TooltipContent>
                                    </Tooltip>
                                  )}
                                </div>
                              )}
                            </>
                          )}
                        </li>
                      );
                    })}
                  </ul>
                )}
              </div>
            </Section>
          </div>
        </SheetContent>
      </Sheet>

      <AlertDialog open={deleteTarget !== null} onOpenChange={(v) => { if (!v) setDeleteTarget(null); }}>
        <AlertDialogContent dir="rtl">
          <AlertDialogHeader>
            <AlertDialogTitle>מחיקת קטגוריה</AlertDialogTitle>
            <AlertDialogDescription>
              האם למחוק את הקטגוריה{' '}
              <strong className="font-semibold text-slate-900">
                &quot;{deleteTarget?.name ?? ''}&quot;
              </strong>
              ? פעולה זו אינה ניתנת לביטול.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={busyId !== null}>ביטול</AlertDialogCancel>
            <AlertDialogAction
              onClick={confirmDelete}
              disabled={busyId !== null}
              className="gap-2 bg-destructive text-white hover:bg-destructive/90"
            >
              <Trash2 className="h-4 w-4" />
              מחק
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
