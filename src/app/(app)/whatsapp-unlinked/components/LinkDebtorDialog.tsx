'use client';

import { useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import { Search, Loader2, Link2, Phone } from 'lucide-react';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { formatPhoneDisplay } from '@/lib/phone';
import type { UnlinkedMessage } from '@/types/whatsapp';
import type { DebtorSearchResult } from '@/lib/db/debtors';

export function LinkDebtorDialog({
  message,
  onOpenChange,
  onLinked,
}: {
  message: UnlinkedMessage | null;
  onOpenChange: (open: boolean) => void;
  onLinked: () => void | Promise<void>;
}) {
  const open = message !== null;
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<DebtorSearchResult[]>([]);
  const [searching, setSearching] = useState(false);
  const [linkingId, setLinkingId] = useState<string | null>(null);

  // Reset on open.
  useEffect(() => {
    if (open) { setQuery(''); setResults([]); setLinkingId(null); }
  }, [open]);

  // Debounced search.
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (!open) return;
    const q = query.trim();
    if (debounceRef.current) clearTimeout(debounceRef.current);
    if (q.length < 2) { setResults([]); setSearching(false); return; }
    setSearching(true);
    debounceRef.current = setTimeout(async () => {
      try {
        const r = await fetch(`/api/debtors/search?q=${encodeURIComponent(q)}`, { credentials: 'include' });
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        setResults((await r.json()) as DebtorSearchResult[]);
      } catch {
        setResults([]);
      } finally {
        setSearching(false);
      }
    }, 300);
    return () => { if (debounceRef.current) clearTimeout(debounceRef.current); };
  }, [query, open]);

  async function linkTo(debtor: DebtorSearchResult) {
    if (!message || linkingId) return;
    setLinkingId(debtor.id);
    try {
      const r = await fetch(`/api/whatsapp/messages/${message.id}/link`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ debtor_id: debtor.id }),
      });
      const data = (await r.json().catch(() => ({}))) as { error?: string; linked?: number };
      if (!r.ok) throw new Error(data.error || `HTTP ${r.status}`);
      toast.success(`שויכו ${data.linked ?? 1} הודעות לדירה ${debtor.apartment_number}`);
      await onLinked();
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setLinkingId(null);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent dir="rtl" className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>שיוך הודעה לחייב</DialogTitle>
          <DialogDescription className="flex items-center gap-1.5">
            <Phone className="h-3.5 w-3.5" />
            <span dir="ltr" className="tabular-nums">
              {message ? formatPhoneDisplay(message.contact_phone) ?? message.contact_phone : ''}
            </span>
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          <div className="relative">
            <Search className="pointer-events-none absolute end-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="חיפוש לפי מספר דירה או שם..."
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
              <p className="py-6 text-center text-sm text-slate-400">לא נמצאו חייבים תואמים.</p>
            ) : (
              results.map((d) => (
                <button
                  key={d.id}
                  type="button"
                  onClick={() => linkTo(d)}
                  disabled={linkingId !== null}
                  className="flex w-full items-center justify-between gap-3 rounded-lg border border-slate-200 bg-white p-3 text-start transition-colors hover:bg-slate-50 disabled:opacity-60"
                >
                  <div className="min-w-0">
                    <div className="text-sm font-semibold text-slate-900">
                      דירה {d.apartment_number}
                      {d.is_archived && <span className="me-2 text-xs font-normal text-amber-600"> (בארכיון)</span>}
                    </div>
                    <div className="truncate text-xs text-muted-foreground">
                      {d.owner_name ?? d.tenant_name ?? 'ללא שם'}
                    </div>
                  </div>
                  {linkingId === d.id ? (
                    <Loader2 className="h-4 w-4 shrink-0 animate-spin text-emerald-600" />
                  ) : (
                    <Link2 className="h-4 w-4 shrink-0 text-emerald-600" />
                  )}
                </button>
              ))
            )}
          </div>
        </div>

        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
            ביטול
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
