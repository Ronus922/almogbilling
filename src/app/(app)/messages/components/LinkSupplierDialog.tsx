'use client';

import { useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import {
  Search, Loader2, Link2, Phone, Wrench, Plus, ArrowRight, Tag,
} from 'lucide-react';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select';
import { formatPhoneDisplay } from '@/lib/phone';
import { cn } from '@/lib/utils';
import type { UnlinkedMessage, SupplierSearchResult } from '@/types/whatsapp';
import type { SupplierCategory } from '@/lib/types/suppliers';

// Sentinel for "no category" — base-ui Select needs a non-empty value.
const NONE = '__none__';

type Mode = 'list' | 'create';

/**
 * Attach an unlinked (or re-link an already-linked) WhatsApp conversation to a
 * SUPPLIER — the twin of LinkDebtorDialog. Two modes:
 *   • list   — search existing suppliers and pick one.
 *   • create — make a minimal supplier from this number, then link it (only when
 *              the user has suppliers:edit; otherwise the entry is hidden).
 */
export function LinkSupplierDialog({
  message,
  canCreate,
  onOpenChange,
  onLinked,
}: {
  message: UnlinkedMessage | null;
  /** suppliers:edit — gates the "create supplier from this number" path. */
  canCreate: boolean;
  onOpenChange: (open: boolean) => void;
  onLinked: () => void | Promise<void>;
}) {
  const open = message !== null;
  const [mode, setMode] = useState<Mode>('list');

  // List mode.
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<SupplierSearchResult[]>([]);
  const [searching, setSearching] = useState(false);
  const [linkingId, setLinkingId] = useState<string | null>(null);

  // Create mode.
  const [name, setName] = useState('');
  const [categoryId, setCategoryId] = useState<string>(NONE);
  const [categories, setCategories] = useState<SupplierCategory[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const [touched, setTouched] = useState(false);

  const phoneDisplay = message
    ? formatPhoneDisplay(message.contact_phone) ?? message.contact_phone
    : '';

  // Reset on open.
  useEffect(() => {
    if (open) {
      setMode('list');
      setQuery('');
      setResults([]);
      setLinkingId(null);
      setName('');
      setCategoryId(NONE);
      setSubmitting(false);
      setTouched(false);
    }
  }, [open]);

  // Debounced supplier search.
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (!open || mode !== 'list') return;
    const q = query.trim();
    if (debounceRef.current) clearTimeout(debounceRef.current);
    if (q.length < 2) { setResults([]); setSearching(false); return; }
    setSearching(true);
    debounceRef.current = setTimeout(async () => {
      try {
        const r = await fetch(`/api/suppliers/search?q=${encodeURIComponent(q)}`, { credentials: 'include' });
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        setResults((await r.json()) as SupplierSearchResult[]);
      } catch {
        setResults([]);
      } finally {
        setSearching(false);
      }
    }, 300);
    return () => { if (debounceRef.current) clearTimeout(debounceRef.current); };
  }, [query, open, mode]);

  // Lazy-load categories the first time the create form opens (degrades to an
  // empty list — category is optional — if the user lacks suppliers:view).
  async function enterCreate() {
    setMode('create');
    if (categories.length === 0) {
      try {
        const r = await fetch('/api/suppliers/categories', { credentials: 'include' });
        if (r.ok) setCategories((await r.json()) as SupplierCategory[]);
      } catch {
        /* category select just stays "ללא קטגוריה" */
      }
    }
  }

  async function linkTo(supplier: SupplierSearchResult) {
    if (!message || linkingId) return;
    setLinkingId(supplier.id);
    try {
      const r = await fetch(`/api/whatsapp/messages/${message.id}/link`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ supplier_id: supplier.id }),
      });
      const data = (await r.json().catch(() => ({}))) as { error?: string; linked?: number };
      if (!r.ok) throw new Error(data.error || `HTTP ${r.status}`);
      toast.success(`השיחה שויכה לספק ${supplier.display_name}`);
      await onLinked();
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setLinkingId(null);
    }
  }

  async function createAndLink() {
    if (!message || submitting) return;
    if (!name.trim()) { setTouched(true); return; }
    setSubmitting(true);
    try {
      const r = await fetch(`/api/whatsapp/messages/${message.id}/create-supplier`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({
          display_name: name.trim(),
          category_id: categoryId === NONE ? null : categoryId,
        }),
      });
      const data = (await r.json().catch(() => ({}))) as { error?: string; id?: string };
      if (!r.ok) throw new Error(data.error || `HTTP ${r.status}`);
      toast.success(`הספק ${name.trim()} נוצר והשיחה שויכה אליו`);
      await onLinked();
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent dir="rtl" className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Wrench className="h-4 w-4 text-amber-600" />
            {mode === 'list' ? 'שיוך שיחה לספק' : 'ספק חדש מהשיחה'}
          </DialogTitle>
          <DialogDescription className="flex items-center gap-1.5">
            <Phone className="h-3.5 w-3.5" />
            <span dir="ltr" className="tabular-nums">{phoneDisplay}</span>
          </DialogDescription>
        </DialogHeader>

        {mode === 'list' ? (
          <div className="space-y-3">
            <div className="relative">
              <Search className="pointer-events-none absolute end-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="חיפוש לפי שם ספק, איש קשר או טלפון..."
                className="h-10 pe-9"
                autoFocus
              />
            </div>

            <div className="max-h-72 space-y-1.5 overflow-y-auto">
              {searching ? (
                <div className="flex items-center justify-center gap-2 py-6 text-sm text-slate-400">
                  <Loader2 className="h-4 w-4 animate-spin" />
                  מחפש…
                </div>
              ) : query.trim().length < 2 ? (
                <p className="py-6 text-center text-sm text-slate-400">הקלד לפחות 2 תווים לחיפוש.</p>
              ) : results.length === 0 ? (
                <p className="py-6 text-center text-sm text-slate-400">לא נמצאו ספקים תואמים.</p>
              ) : (
                results.map((s) => {
                  const phone = s.mobile || s.phone;
                  return (
                    <button
                      key={s.id}
                      type="button"
                      onClick={() => linkTo(s)}
                      disabled={linkingId !== null}
                      className="flex w-full items-center justify-between gap-3 rounded-lg border border-slate-200 bg-white p-3 text-start transition-colors hover:bg-amber-50/60 disabled:opacity-60"
                    >
                      <div className="min-w-0">
                        <div className="truncate text-sm font-semibold text-slate-900">{s.display_name}</div>
                        <div className="flex items-center gap-2 truncate text-xs text-muted-foreground">
                          {phone && <span dir="ltr" className="tabular-nums">{formatPhoneDisplay(phone) ?? phone}</span>}
                          {s.category_name && (
                            <span className="inline-flex items-center gap-1 rounded bg-slate-100 px-1.5 py-0.5 text-[10px] font-semibold text-slate-500">
                              <Tag className="h-3 w-3" />
                              {s.category_name}
                            </span>
                          )}
                        </div>
                      </div>
                      {linkingId === s.id ? (
                        <Loader2 className="h-4 w-4 shrink-0 animate-spin text-amber-600" />
                      ) : (
                        <Link2 className="h-4 w-4 shrink-0 text-amber-600" />
                      )}
                    </button>
                  );
                })
              )}
            </div>

            {canCreate && (
              <button
                type="button"
                onClick={() => void enterCreate()}
                className="flex w-full items-center justify-center gap-2 rounded-lg border border-dashed border-amber-300 bg-amber-50/40 px-4 py-2.5 text-sm font-semibold text-amber-700 transition-colors hover:bg-amber-50"
              >
                <Plus className="h-4 w-4" />
                צור ספק חדש מהמספר הזה
              </button>
            )}
          </div>
        ) : (
          <div className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="new-supplier-name" className="text-base font-medium text-muted-foreground">
                שם הספק <span className="text-red-500">*</span>
              </Label>
              <Input
                id="new-supplier-name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                onBlur={() => setTouched(true)}
                placeholder="לדוגמה: חשמלאי דני"
                disabled={submitting}
                autoFocus
                className={cn('h-10', touched && !name.trim() && 'border-red-400 bg-red-50 focus-visible:ring-red-200')}
              />
              {touched && !name.trim() && (
                <p className="text-[12px] font-semibold text-red-500 text-start">⚠️ שם הספק הוא שדה חובה</p>
              )}
            </div>

            <div className="space-y-2">
              <Label className="flex items-center gap-1.5 text-base font-medium text-muted-foreground">
                טלפון
                <span className="rounded bg-amber-100 px-1.5 py-0.5 text-[10px] font-semibold text-amber-700">מהשיחה</span>
              </Label>
              <Input
                value={phoneDisplay}
                readOnly
                dir="ltr"
                tabIndex={-1}
                className="h-10 cursor-default tabular-nums bg-slate-50 text-slate-600"
              />
            </div>

            <div className="space-y-2">
              <Label className="text-base font-medium text-muted-foreground">קטגוריה</Label>
              <Select value={categoryId} onValueChange={(v) => setCategoryId(v ?? NONE)} disabled={submitting}>
                <SelectTrigger className="w-full data-[size=default]:h-10">
                  <SelectValue placeholder="בחר קטגוריה...">
                    {(value: string | null) => {
                      if (!value || value === NONE) return 'ללא קטגוריה';
                      return categories.find((c) => c.id === value)?.name ?? 'קטגוריה';
                    }}
                  </SelectValue>
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={NONE}>ללא קטגוריה</SelectItem>
                  {categories.map((c) => (
                    <SelectItem key={c.id} value={c.id}>{c.name}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <p className="text-xs text-muted-foreground">
              נשמרים השם והטלפון בלבד — אפשר להשלים את שאר פרטי הספק לאחר מכן במסך הספקים.
            </p>
          </div>
        )}

        <DialogFooter className="gap-2 sm:gap-2">
          {mode === 'list' ? (
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              ביטול
            </Button>
          ) : (
            <>
              <Button
                type="button"
                variant="outline"
                onClick={() => setMode('list')}
                disabled={submitting}
                className="gap-1.5"
              >
                <ArrowRight className="h-4 w-4" />
                חזרה
              </Button>
              <Button
                type="button"
                variant="approve"
                onClick={() => void createAndLink()}
                disabled={submitting || !name.trim()}
                className="gap-1.5"
              >
                {submitting ? <Loader2 className="h-4 w-4 animate-spin" /> : <Wrench className="h-4 w-4" />}
                {submitting ? 'יוצר…' : 'צור ושייך'}
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
