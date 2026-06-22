'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Search, Users, Truck, AlertTriangle, FileText, Loader2, type LucideIcon } from 'lucide-react';
import {
  CommandDialog,
  Command,
  CommandInput,
  CommandList,
  CommandEmpty,
  CommandGroup,
  CommandItem,
} from '@/components/ui/command';

type SearchType = 'debtor' | 'supplier' | 'issue' | 'document';

interface SearchResult {
  type: SearchType;
  id: string;
  title: string;
  subtitle: string;
  href: string;
}

const MIN_CHARS = 2;
const DEBOUNCE_MS = 250;

// Fixed display order + per-type label/icon. A group renders only when it has hits.
const GROUPS: { type: SearchType; label: string; icon: LucideIcon }[] = [
  { type: 'debtor', label: 'דיירים', icon: Users },
  { type: 'supplier', label: 'ספקים', icon: Truck },
  { type: 'issue', label: 'תקלות', icon: AlertTriangle },
  { type: 'document', label: 'מסמכים', icon: FileText },
];

/** Header search slot: a visual trigger that opens the palette. The real input
 *  lives inside the dialog. Global ⌘K / Ctrl+K toggles it from anywhere. */
export function GlobalSearch() {
  const [open, setOpen] = useState(false);
  const [isMac, setIsMac] = useState(false);

  useEffect(() => {
    setIsMac(/mac|iphone|ipad|ipod/i.test(navigator.platform));
    function onKey(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && (e.key === 'k' || e.key === 'K')) {
        e.preventDefault();
        setOpen((o) => !o);
      }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        aria-label="חיפוש"
        className="relative flex h-11 w-full items-center rounded-[13px] border border-line bg-surface-2 pr-11 pl-2.5 text-start transition-colors hover:border-line-strong hover:bg-white focus:border-brand focus:outline-none focus:ring-4 focus:ring-brand/10"
      >
        <Search className="pointer-events-none absolute right-3.5 h-[18px] w-[18px] text-ink-3" aria-hidden />
        <span className="flex-1 truncate text-[13.5px] font-medium text-ink-3">חיפוש דייר, ספק, תקלה או מסמך…</span>
        <kbd className="hidden shrink-0 items-center rounded-md border border-line bg-white px-1.5 py-0.5 text-[11px] font-bold text-ink-3 sm:inline-flex">
          {isMac ? '⌘K' : 'Ctrl K'}
        </kbd>
      </button>
      <SearchPalette open={open} onOpenChange={setOpen} />
    </>
  );
}

function SearchPalette({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const router = useRouter();
  const inputRef = useRef<HTMLInputElement>(null);
  const abortRef = useRef<AbortController | null>(null);

  const [q, setQ] = useState('');
  const [results, setResults] = useState<SearchResult[]>([]);
  const [loading, setLoading] = useState(false);
  const [active, setActive] = useState(0);

  // Reset everything when the palette closes; focus the input when it opens.
  useEffect(() => {
    if (!open) {
      setQ('');
      setResults([]);
      setActive(0);
      setLoading(false);
      abortRef.current?.abort();
      return;
    }
    const t = setTimeout(() => inputRef.current?.focus(), 30);
    return () => clearTimeout(t);
  }, [open]);

  // Debounced fetch + AbortController (cancels superseded requests).
  useEffect(() => {
    const term = q.trim();
    if (term.length < MIN_CHARS) {
      abortRef.current?.abort();
      setResults([]);
      setLoading(false);
      return;
    }
    setLoading(true);
    const t = setTimeout(() => {
      abortRef.current?.abort();
      const ctrl = new AbortController();
      abortRef.current = ctrl;
      void (async () => {
        try {
          const r = await fetch(`/api/search?q=${encodeURIComponent(term)}`, {
            credentials: 'include',
            signal: ctrl.signal,
          });
          if (!r.ok) {
            setResults([]);
            setLoading(false);
            return;
          }
          const data = (await r.json()) as SearchResult[];
          setResults(Array.isArray(data) ? data : []);
          setActive(0);
          setLoading(false);
        } catch (err) {
          if ((err as Error).name !== 'AbortError') {
            setResults([]);
            setLoading(false);
          }
        }
      })();
    }, DEBOUNCE_MS);
    return () => clearTimeout(t);
  }, [q]);

  // Group by source (display order); attach a global index for keyboard nav.
  const { groups, flat } = useMemo(() => {
    const flatList: SearchResult[] = [];
    const grouped = GROUPS.map((g) => {
      const items = results
        .filter((r) => r.type === g.type)
        .map((res) => ({ res, index: flatList.push(res) - 1 }));
      return { ...g, items };
    }).filter((g) => g.items.length > 0);
    return { groups: grouped, flat: flatList };
  }, [results]);

  const go = useCallback(
    (res: SearchResult) => {
      onOpenChange(false);
      router.push(res.href);
    },
    [onOpenChange, router],
  );

  const onKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLInputElement>) => {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setActive((i) => (flat.length ? Math.min(i + 1, flat.length - 1) : 0));
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        setActive((i) => Math.max(i - 1, 0));
      } else if (e.key === 'Enter') {
        e.preventDefault();
        const sel = flat[active];
        if (sel) go(sel);
      }
    },
    [flat, active, go],
  );

  const term = q.trim();

  return (
    <CommandDialog open={open} onOpenChange={onOpenChange}>
      <Command>
        <CommandInput
          ref={inputRef}
          value={q}
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={onKeyDown}
          placeholder="חיפוש דייר, ספק, תקלה או מסמך…"
          aria-label="חיפוש גלובלי"
        />
        <CommandList>
          {term.length < MIN_CHARS ? (
            <CommandEmpty>הקלד לפחות 2 תווים לחיפוש</CommandEmpty>
          ) : loading && flat.length === 0 ? (
            <div className="flex items-center justify-center gap-2 px-4 py-10 text-[13px] font-medium text-ink-3">
              <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
              מחפש…
            </div>
          ) : flat.length === 0 ? (
            <CommandEmpty>לא נמצאו תוצאות עבור «{term}»</CommandEmpty>
          ) : (
            groups.map((g) => {
              const Icon = g.icon;
              return (
                <CommandGroup key={g.type} heading={g.label}>
                  {g.items.map(({ res, index }) => (
                    <CommandItem
                      key={`${res.type}-${res.id}`}
                      active={index === active}
                      onSelect={() => go(res)}
                      onMouseMove={() => setActive(index)}
                    >
                      <span className="grid h-9 w-9 shrink-0 place-items-center rounded-[10px] bg-brand-soft text-brand-text">
                        <Icon className="h-[18px] w-[18px]" aria-hidden />
                      </span>
                      <span className="flex min-w-0 flex-1 flex-col">
                        <span className="truncate text-[13.5px] font-bold text-ink">{res.title}</span>
                        {res.subtitle && <span className="truncate text-[12px] text-ink-3">{res.subtitle}</span>}
                      </span>
                    </CommandItem>
                  ))}
                </CommandGroup>
              );
            })
          )}
        </CommandList>
      </Command>
    </CommandDialog>
  );
}
