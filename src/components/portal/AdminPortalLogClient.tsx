'use client';

// /admin/portal-log — the WHOLE owners-portal login log, including attempts from
// phones that are not on the roster (they show "—" in the apartment column).
//
// Filters live in the URL so a filtered view is linkable and survives a refresh;
// the fetch runs on every filter change, server-side (listPortalEvents) — never a
// client-side filter over a full download.

import { useCallback, useEffect, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { Search, ShieldCheck, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select';
import { cn } from '@/lib/utils';
import { PORTAL_EVENT_LABEL, PORTAL_EVENT_TYPES, type PortalEventType } from '@/lib/constants/portal';
import type { PortalLoginEvent } from '@/lib/types/portal';
import { PortalLogTable } from './PortalLogTable';

const ANY = 'all';

interface Filters {
  eventType: string;
  phone: string;
  apartment: string;
  from: string;
  to: string;
}

function fromParams(sp: URLSearchParams): Filters {
  return {
    eventType: sp.get('event_type') ?? ANY,
    phone: sp.get('phone') ?? '',
    apartment: sp.get('apartment') ?? '',
    from: sp.get('from') ?? '',
    to: sp.get('to') ?? '',
  };
}

function toQuery(f: Filters): string {
  const q = new URLSearchParams();
  if (f.eventType !== ANY) q.set('event_type', f.eventType);
  if (f.phone.trim()) q.set('phone', f.phone.trim());
  if (f.apartment.trim()) q.set('apartment', f.apartment.trim());
  if (f.from) q.set('from', f.from);
  if (f.to) q.set('to', f.to);
  return q.toString();
}

/** A date input whose whole surface opens the picker (DESIGN.md §6). */
function DateField({ id, label, value, onChange }: {
  id: string; label: string; value: string; onChange: (v: string) => void;
}) {
  return (
    <div className="space-y-2">
      <Label htmlFor={id} className="text-[13px] font-semibold text-slate-700">{label}</Label>
      <Input
        id={id}
        type="date"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onClick={(e) => {
          const el = e.currentTarget as HTMLInputElement & { showPicker?: () => void };
          try { el.showPicker?.(); } catch { /* fall back to the native icon */ }
        }}
        className="h-10 cursor-pointer"
      />
    </div>
  );
}

export function AdminPortalLogClient() {
  const router = useRouter();
  const sp = useSearchParams();
  const [filters, setFilters] = useState<Filters>(() => fromParams(new URLSearchParams(sp.toString())));
  const [events, setEvents] = useState<PortalLoginEvent[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  // The URL is the source of truth: a Back/Forward or a pasted link re-syncs the
  // form instead of leaving it showing filters that are no longer applied.
  const search = sp.toString();
  useEffect(() => { setFilters(fromParams(new URLSearchParams(search))); }, [search]);

  const load = useCallback(async (qs: string) => {
    setLoading(true); setError(null);
    try {
      const res = await fetch(`/api/admin/portal-log${qs ? `?${qs}` : ''}`, { credentials: 'include' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = (await res.json()) as { events: PortalLoginEvent[] };
      setEvents(data.events);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(search); }, [load, search]);

  function apply(next: Filters) {
    const qs = toQuery(next);
    router.replace(qs ? `/admin/portal-log?${qs}` : '/admin/portal-log', { scroll: false });
  }

  const hasFilters = toQuery(filters).length > 0;

  return (
    <div className="space-y-6">
      <header className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
        <div>
          <h1 className="text-2xl font-extrabold text-slate-900">התחברויות לפורטל</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            כל הניסיונות להיכנס לפורטל בעלי הדירות — כולל ניסיונות ממספרים שאינם רשומים.
          </p>
        </div>
        <span className="inline-flex h-11 shrink-0 items-center gap-2 rounded-xl border border-line bg-white px-3 text-sm font-semibold text-ink-2">
          <ShieldCheck className="h-4 w-4 text-violet-600" aria-hidden />
          {events ? `${events.length} אירועים` : '—'}
        </span>
      </header>

      <form
        onSubmit={(e) => { e.preventDefault(); apply(filters); }}
        className="space-y-4 rounded-2xl border border-line bg-white p-4 shadow-soft-sm"
      >
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-5">
          <div className="space-y-2">
            <Label htmlFor="pl-event" className="text-[13px] font-semibold text-slate-700">סוג אירוע</Label>
            <Select value={filters.eventType} onValueChange={(v) => setFilters((f) => ({ ...f, eventType: v ?? ANY }))}>
              <SelectTrigger id="pl-event" className="w-full data-[size=default]:h-10">
                <SelectValue placeholder="כל הסוגים" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={ANY}>כל הסוגים</SelectItem>
                {PORTAL_EVENT_TYPES.map((t) => (
                  <SelectItem key={t} value={t}>{PORTAL_EVENT_LABEL[t as PortalEventType]}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-2">
            <Label htmlFor="pl-phone" className="text-[13px] font-semibold text-slate-700">טלפון</Label>
            <div className="relative">
              <Search className="pointer-events-none absolute start-3 top-1/2 h-4 w-4 -translate-y-1/2 text-ink-3" aria-hidden />
              <Input
                id="pl-phone"
                value={filters.phone}
                onChange={(e) => setFilters((f) => ({ ...f, phone: e.target.value }))}
                placeholder="0541234567"
                dir="ltr"
                className={cn('h-10 ps-9 font-num tabular-nums', filters.phone && 'pe-9')}
              />
              {filters.phone && (
                <button
                  type="button"
                  aria-label="נקה טלפון"
                  onClick={() => setFilters((f) => ({ ...f, phone: '' }))}
                  className="absolute end-2 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-600"
                >
                  <X className="h-4 w-4" />
                </button>
              )}
            </div>
          </div>

          <div className="space-y-2">
            <Label htmlFor="pl-apt" className="text-[13px] font-semibold text-slate-700">דירה</Label>
            <div className="relative">
              <Search className="pointer-events-none absolute start-3 top-1/2 h-4 w-4 -translate-y-1/2 text-ink-3" aria-hidden />
              <Input
                id="pl-apt"
                value={filters.apartment}
                onChange={(e) => setFilters((f) => ({ ...f, apartment: e.target.value }))}
                placeholder="1218"
                dir="ltr"
                className={cn('h-10 ps-9 font-num tabular-nums', filters.apartment && 'pe-9')}
              />
              {filters.apartment && (
                <button
                  type="button"
                  aria-label="נקה דירה"
                  onClick={() => setFilters((f) => ({ ...f, apartment: '' }))}
                  className="absolute end-2 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-600"
                >
                  <X className="h-4 w-4" />
                </button>
              )}
            </div>
          </div>

          <DateField id="pl-from" label="מתאריך" value={filters.from} onChange={(v) => setFilters((f) => ({ ...f, from: v }))} />
          <DateField id="pl-to" label="עד תאריך" value={filters.to} onChange={(v) => setFilters((f) => ({ ...f, to: v }))} />
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <Button type="submit" disabled={loading}>{loading ? 'מסנן…' : 'סנן'}</Button>
          {hasFilters && (
            <Button
              type="button"
              variant="secondary"
              onClick={() => { const empty = fromParams(new URLSearchParams()); setFilters(empty); apply(empty); }}
            >
              נקה סינון
            </Button>
          )}
        </div>
      </form>

      {error ? (
        <div className="rounded-lg border border-destructive/30 bg-destructive/5 p-4 text-sm text-destructive">
          שגיאה בטעינת הלוג: {error}
        </div>
      ) : !events ? (
        <div className="h-64 animate-pulse rounded-xl bg-muted/60" />
      ) : (
        <PortalLogTable events={events} showApartment />
      )}
    </div>
  );
}
