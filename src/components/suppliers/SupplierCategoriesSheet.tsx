'use client';

import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { Plus, Pencil, Trash2, Check, X, Folder, Ban } from 'lucide-react';
import { Sheet, SheetContent, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { SupplierSection } from './SupplierSection';
import { cn } from '@/lib/utils';
import { REMINDER_CATEGORY_COLORS } from '@/lib/constants/userReminders';
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
  const [newColor, setNewColor] = useState<string | null>(null);
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
      setNewColor(null);
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
        body: JSON.stringify({ name, color: newColor }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        toast.error(body.message || body.errors?.name || `הוספה נכשלה: HTTP ${res.status}`);
        return;
      }
      toast.success('הקטגוריה נוספה');
      setNewName('');
      setNewColor(null);
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

  async function saveColor(cat: SupplierCategoryWithCount, color: string | null) {
    if (cat.color === color) return;
    setBusyId(cat.id);
    const prev = rows;
    setRows((rs) => rs.map((r) => (r.id === cat.id ? { ...r, color } : r)));
    try {
      const res = await fetch(`/api/suppliers/categories/${cat.id}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ color }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.message || `HTTP ${res.status}`);
      }
      toast.success('הצבע עודכן');
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
          {/* Header — DETAIL family (navy diagonal gradient) */}
          <SheetHeader className="flex-none gap-2 bg-[linear-gradient(120deg,#0e1f4d_0%,#16308a_55%,#1d4ed8_100%)] px-8 py-5 text-white">
            <div className="flex items-start justify-between gap-4">
              <div className="min-w-0 flex-1">
                <SheetTitle className="text-[23px] font-extrabold text-white">ניהול קטגוריות</SheetTitle>
                <p className="mt-1 text-[13px] font-medium text-[#c7dbff]/80">
                  הוספה, שינוי שם, השבתה ומחיקה של קטגוריות הספקים.
                </p>
              </div>
              <button
                type="button"
                onClick={() => onOpenChange(false)}
                aria-label="סגור"
                className="flex h-11 w-11 shrink-0 items-center justify-center rounded-[13px] bg-white/[0.14] text-white transition-colors hover:bg-white/[0.26]"
              >
                <X className="h-5 w-5" strokeWidth={2.2} />
              </button>
            </div>
          </SheetHeader>

          {/* Body */}
          <div className="flex-1 overflow-y-auto bg-[#f4f6fb] p-6">
            <SupplierSection title="קטגוריות" icon={Folder} iconTone="blue">
              {/* Add row */}
              {canEdit && (
                <div className="mb-2 flex gap-[10px]">
                  <ColorSwatchPicker
                    value={newColor}
                    onChange={setNewColor}
                    disabled={adding}
                    triggerClassName="h-[46px] w-[46px] rounded-[11px]"
                  />
                  <Input
                    value={newName}
                    onChange={(e) => setNewName(e.target.value)}
                    onKeyDown={(e) => { if (e.key === 'Enter') void addCategory(); }}
                    placeholder="שם קטגוריה חדשה…"
                    className="h-[46px] flex-1 rounded-[11px] border-[#e2e8f0] px-[14px] text-[14px] text-[#0f172a]"
                  />
                  <Button
                    type="button"
                    onClick={addCategory}
                    disabled={adding || newName.trim() === ''}
                    className="h-[46px] shrink-0 gap-[7px] rounded-[11px] bg-gradient-to-l from-[#1d4ed8] to-[#2563eb] px-[22px] text-[14px] font-bold text-white shadow-[0_8px_18px_-6px_rgba(37,99,235,0.5)] hover:from-[#1e40af] hover:to-[#1d4ed8]"
                  >
                    <Plus className="h-4 w-4" strokeWidth={2.3} />
                    הוסף
                  </Button>
                </div>
              )}

              {/* List */}
              {loading ? (
                <div className="space-y-2">
                  <div className="h-12 rounded-lg bg-slate-100 animate-pulse" />
                  <div className="h-12 rounded-lg bg-slate-100 animate-pulse" />
                  <div className="h-12 rounded-lg bg-slate-100 animate-pulse" />
                </div>
              ) : rows.length === 0 ? (
                <div className="flex flex-col items-center justify-center gap-3 py-10 text-center">
                  <span className="grid h-12 w-12 place-items-center rounded-[13px] bg-[#e8f0ff] text-[#2563eb]">
                    <Folder className="h-5 w-5" />
                  </span>
                  <p className="text-sm text-muted-foreground">טרם הוגדרו קטגוריות.</p>
                </div>
              ) : (
                <div>
                  {rows.map((cat) => {
                    const isEditing = editingId === cat.id;
                    const rowBusy = busyId === cat.id;
                    const blocked = cat.linked_count > 0;
                    return (
                      <div
                        key={cat.id}
                        className={cn(
                          'flex items-center justify-between gap-4 border-b border-[#f1f4f8] px-[6px] py-[14px] last:border-0',
                          !cat.is_active && !isEditing && 'opacity-60',
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
                              className="h-[42px] flex-1 rounded-[10px] border-[#e2e8f0] px-[13px] text-[14px]"
                            />
                            <div className="flex shrink-0 items-center gap-[6px]">
                              <button
                                type="button"
                                onClick={() => saveRename(cat.id)}
                                disabled={rowBusy || editName.trim() === ''}
                                aria-label="שמור"
                                className="grid h-[34px] w-[34px] place-items-center rounded-[9px] text-[#16a34a] transition-colors hover:bg-[#e7f7ee] disabled:opacity-40"
                              >
                                <Check className="h-4 w-4" />
                              </button>
                              <button
                                type="button"
                                onClick={() => setEditingId(null)}
                                disabled={rowBusy}
                                aria-label="ביטול"
                                className="grid h-[34px] w-[34px] place-items-center rounded-[9px] text-[#64748b] transition-colors hover:bg-[#eef2f7]"
                              >
                                <X className="h-4 w-4" />
                              </button>
                            </div>
                          </>
                        ) : (
                          <>
                            {/* name (RTL start = right) */}
                            <span className="truncate text-[15px] font-bold text-[#0f172a]">
                              {cat.name}
                            </span>
                            {/* controls (RTL end = left) */}
                            <div className="flex shrink-0 items-center gap-[6px]">
                              {canEdit && (
                                <ColorSwatchPicker
                                  value={cat.color}
                                  onChange={(hex) => saveColor(cat, hex)}
                                  disabled={rowBusy}
                                />
                              )}
                              <span className="inline-flex items-center rounded-full bg-[#eef2f7] px-[10px] py-[4px] text-xs font-semibold text-[#64748b] whitespace-nowrap">
                                {cat.linked_count} ספקים
                              </span>
                              {canEdit && (
                                <>
                                  {/* toggle (42×24) */}
                                  <button
                                    type="button"
                                    role="switch"
                                    aria-checked={cat.is_active}
                                    onClick={() => toggleActive(cat, !cat.is_active)}
                                    disabled={rowBusy}
                                    aria-label={cat.is_active ? 'השבת קטגוריה' : 'הפעל קטגוריה'}
                                    className={cn(
                                      'relative h-6 w-[42px] shrink-0 cursor-pointer rounded-full transition-colors disabled:opacity-50',
                                      cat.is_active ? 'bg-[#2563eb]' : 'bg-slate-300',
                                    )}
                                  >
                                    <span
                                      className={cn(
                                        'absolute top-[3px] h-[18px] w-[18px] rounded-full bg-white shadow-[0_1px_2px_rgba(0,0,0,0.2)] transition-all',
                                        cat.is_active ? 'left-[3px]' : 'right-[3px]',
                                      )}
                                    />
                                  </button>
                                  {/* rename */}
                                  <button
                                    type="button"
                                    onClick={() => { setEditingId(cat.id); setEditName(cat.name); }}
                                    disabled={rowBusy}
                                    aria-label="עריכת שם"
                                    className="grid h-[34px] w-[34px] place-items-center rounded-[9px] text-[#64748b] transition-colors hover:bg-[#eef2f7]"
                                  >
                                    <Pencil className="h-4 w-4" />
                                  </button>
                                  {/* delete (red) or locked (greyed) */}
                                  {blocked ? (
                                    <Tooltip>
                                      <TooltipTrigger render={<span className="inline-flex" />}>
                                        <span
                                          aria-label="לא ניתן למחוק"
                                          className="grid h-[34px] w-[34px] place-items-center rounded-[9px] text-[#d4dbe6]"
                                        >
                                          <Trash2 className="h-4 w-4" />
                                        </span>
                                      </TooltipTrigger>
                                      <TooltipContent>משויכים ספקים — לא ניתן למחוק</TooltipContent>
                                    </Tooltip>
                                  ) : (
                                    <button
                                      type="button"
                                      onClick={() => setDeleteTarget(cat)}
                                      disabled={rowBusy}
                                      aria-label="מחיקה"
                                      className="grid h-[34px] w-[34px] place-items-center rounded-[9px] text-[#dc2626] transition-colors hover:bg-[#fef2f2]"
                                    >
                                      <Trash2 className="h-4 w-4" />
                                    </button>
                                  )}
                                </>
                              )}
                            </div>
                          </>
                        )}
                      </div>
                    );
                  })}
                </div>
              )}
            </SupplierSection>
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

/**
 * Per-category color picker — a swatch button that opens a palette popover.
 * `null` = no color (the badge then falls back to the name-hash tone). Reuses the
 * shared REMINDER_CATEGORY_COLORS palette + free "no color" option.
 */
function ColorSwatchPicker({
  value,
  onChange,
  disabled,
  triggerClassName,
}: {
  value: string | null;
  onChange: (hex: string | null) => void;
  disabled?: boolean;
  triggerClassName?: string;
}) {
  const [open, setOpen] = useState(false);
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        type="button"
        disabled={disabled}
        aria-label="צבע קטגוריה"
        className={cn(
          'grid h-[34px] w-[34px] shrink-0 place-items-center rounded-[9px] ring-1 ring-slate-200 transition hover:ring-slate-300 disabled:opacity-50',
          triggerClassName,
        )}
      >
        <span
          className="h-4 w-4 rounded-full ring-1 ring-black/5"
          style={{ backgroundColor: value || '#e8eaf2' }}
        />
      </PopoverTrigger>
      <PopoverContent align="end" className="w-auto p-2">
        <div className="grid grid-cols-6 gap-1.5">
          <button
            type="button"
            onClick={() => { onChange(null); setOpen(false); }}
            aria-label="ללא צבע"
            className={cn(
              'grid h-7 w-7 place-items-center rounded-md bg-white text-slate-400 ring-1 ring-slate-200 transition hover:ring-slate-400',
              !value && 'ring-2 ring-blue-600 ring-offset-1',
            )}
          >
            <Ban className="h-3.5 w-3.5" />
          </button>
          {REMINDER_CATEGORY_COLORS.map((c) => {
            const selected = value?.toLowerCase() === c.hex.toLowerCase();
            return (
              <button
                key={c.hex}
                type="button"
                onClick={() => { onChange(c.hex); setOpen(false); }}
                aria-label={c.label}
                className={cn(
                  'h-7 w-7 rounded-md ring-1 ring-slate-200 transition hover:ring-slate-400',
                  selected && 'ring-2 ring-blue-600 ring-offset-1',
                )}
                style={{ backgroundColor: c.hex }}
              />
            );
          })}
        </div>
      </PopoverContent>
    </Popover>
  );
}
