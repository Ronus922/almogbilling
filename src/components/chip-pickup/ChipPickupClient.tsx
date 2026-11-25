'use client';

// "מסירת צ׳יפים" — the guard's pickup screen (/chip-pickup, 25/11/2026).
//
// Residents collect their chips from the guard in the lobby, against an ID
// that matches one of the people of the order. The screen lists ONLY the
// orders that are ready for pickup, and of each one exactly what the guard
// needs: the order number, the apartment(s), the people with the quantity and
// the chip numbers of each, and the total. Nothing else of an order reaches
// this screen at all — GET /api/chip-pickup does not send it.
//
// One action per order, "נמסר": a short confirmation where the guard picks
// which person of the order showed the ID, and confirms. The order becomes
// collected, exactly as the management's "נאסף" makes it.
//
// MOBILE FIRST (a phone or a tablet at the desk): one column of cards, every
// control at least 44px tall, chip numbers that wrap instead of scrolling,
// nothing wider than the screen from 320px up. Two columns from `lg`.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';
import { Check, HandHelping, Loader2, RefreshCw, Search, Smartphone, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  AlertDialog, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter,
  AlertDialogHeader, AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { cn } from '@/lib/utils';
import { CollectorPicker } from '@/components/chips/CollectorPicker';
import { CHIP_ORDER_TEST_LABEL } from '@/lib/chipOrders/model';
import { chipsCountText, filterPickupOrders, pickupCollectors, type PickupOrder } from '@/lib/chipOrders/pickup';

/** The list refreshes by itself this often while the screen is in front — an
 *  order the management marks ready shows up without a reload. */
const REFRESH_MS = 60_000;

const apartmentsText = (apartments: string[]) => (apartments.length === 1 ? 'דירה' : 'דירות');

/** The session ended, or the user's role no longer opens this screen. */
const NO_ACCESS_TEXT = 'אין הרשאה למסך הזה — יש להתחבר מחדש';

export function ChipPickupClient() {
  const router = useRouter();
  const [orders, setOrders] = useState<PickupOrder[] | null>(null);
  const [loadError, setLoadError] = useState('');
  const [refreshing, setRefreshing] = useState(false);
  const [query, setQuery] = useState('');
  // The order being handed over (kept while the dialog closes, so its text
  // does not change on the way out), whether the dialog is open, and the pick.
  const [target, setTarget] = useState<PickupOrder | null>(null);
  const [open, setOpen] = useState(false);
  const [person, setPerson] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  // What the list is asking for. A load is asked for by bumping `tick` — from
  // a click, a timer or the end of a hand-over, never from inside an effect.
  // `quiet` says whether the load that was just asked for is a background one:
  // such a load that fails keeps what is on the screen and says nothing.
  const [tick, setTick] = useState(0);
  const quiet = useRef(false);

  const reload = useCallback((background: boolean) => {
    quiet.current = background;
    if (!background) setRefreshing(true);
    setTick((t) => t + 1);
  }, []);

  // The server said this user may not see the list any more (signed out, the
  // account disabled, the role changed): nothing of it stays on the screen,
  // and the page is asked again — its own guard sends the user where they
  // belong.
  const lockOut = useCallback(() => {
    setOrders([]);
    setOpen(false);
    setTarget(null);
    setLoadError(NO_ACCESS_TEXT);
    router.refresh();
  }, [router]);

  useEffect(() => {
    const ctl = new AbortController();
    const background = quiet.current;
    fetch('/api/chip-pickup', { credentials: 'include', cache: 'no-store', signal: ctl.signal })
      .then(async (res) => {
        const data = (await res.json().catch(() => ({}))) as { orders?: PickupOrder[]; error?: string };
        if (ctl.signal.aborted) return; // a newer ask replaced this one
        if (res.status === 401 || res.status === 403) { lockOut(); return; }
        if (!res.ok || !Array.isArray(data.orders)) throw new Error(data.error ?? 'טעינת ההזמנות נכשלה');
        setOrders(data.orders);
        setLoadError('');
      })
      .catch((e: Error) => {
        if (e.name !== 'AbortError' && !background) setLoadError(e.message || 'טעינת ההזמנות נכשלה');
      })
      .finally(() => {
        if (!ctl.signal.aborted) setRefreshing(false);
      });
    return () => ctl.abort();
  }, [tick, lockOut]);

  // Stay current while the screen is in front: every minute, and at once when
  // the guard comes back to the tab. Never under an open confirmation.
  useEffect(() => {
    const run = () => {
      if (document.visibilityState === 'visible' && !open) reload(true);
    };
    const timer = window.setInterval(run, REFRESH_MS);
    document.addEventListener('visibilitychange', run);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', run);
    };
  }, [reload, open]);

  const visible = useMemo(() => filterPickupOrders(orders ?? [], query), [orders, query]);
  const searching = query.trim() !== '';
  const collectors = target ? pickupCollectors(target) : [];

  function ask(order: PickupOrder) {
    setTarget(order);
    setPerson(null);
    setOpen(true);
  }

  async function handOver() {
    if (!target || !person) return;
    setSaving(true);
    try {
      const res = await fetch(`/api/chip-pickup/${target.id}/handover`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ person }),
      });
      const data = (await res.json().catch(() => ({}))) as { error?: string };
      if (res.status === 401 || res.status === 403) { lockOut(); return; }
      if (!res.ok) {
        // The order is gone or moved behind this screen (already collected, no
        // longer ready, its chips disabled): the confirmation is about an
        // order that is not there any more — closed; the list reloads below.
        if (res.status === 404 || res.status === 409) setOpen(false);
        throw new Error(data.error === 'not_found' ? 'ההזמנה לא נמצאה' : data.error ?? 'הפעולה נכשלה');
      }
      toast.success(`הזמנה ${target.order_number} נמסרה`);
      // It is collected: off the list at once, then the list as the server has it.
      setOrders((prev) => (prev ? prev.filter((o) => o.id !== target.id) : prev));
      setOpen(false);
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setSaving(false);
      // After a refusal too: it means the order moved behind this screen.
      reload(true);
    }
  }

  return (
    <div className="flex flex-col gap-5" data-testid="chip-pickup">
      <div className="flex flex-col gap-4 md:flex-row md:items-end md:justify-between">
        <div className="min-w-0">
          <h1 className="text-2xl font-extrabold text-slate-900">מסירת צ׳יפים</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            הזמנות שמוכנות לאיסוף. מוסרים את הצ׳יפים מול תעודה מזהה של אחד מהאנשים שבהזמנה, ומסמנים „נמסר”.
          </p>
        </div>
        <Button type="button" variant="outline" size="lg" onClick={() => reload(false)} disabled={refreshing}
          className="w-full gap-2 md:w-auto" data-testid="chip-pickup-refresh">
          <RefreshCw className={cn('h-4 w-4', refreshing && 'animate-spin')} aria-hidden />
          רענון
        </Button>
      </div>

      <div className="relative min-w-0">
        <Search aria-hidden className="pointer-events-none absolute start-3 top-1/2 h-4 w-4 -translate-y-1/2 text-ink-3" />
        <Input
          type="search" value={query} enterKeyHint="search" inputMode="search"
          onChange={(e) => setQuery(e.target.value)}
          placeholder="חיפוש לפי מספר דירה או שם..." aria-label="חיפוש לפי מספר דירה או שם"
          data-testid="chip-pickup-search"
          className={cn('h-11 rounded-xl border-line bg-white ps-9 text-base [&::-webkit-search-cancel-button]:hidden', query && 'pe-11')}
        />
        {query && (
          <button
            type="button" aria-label="נקה חיפוש" onClick={() => setQuery('')}
            className="absolute end-0 top-0 grid h-11 w-11 place-items-center text-slate-400 hover:text-slate-600"
          >
            <X className="h-4 w-4" aria-hidden />
          </button>
        )}
      </div>

      {loadError && (
        <div role="alert" className="flex flex-col gap-3 rounded-lg border border-red-200 bg-red-50 p-4 text-sm text-red-700 sm:flex-row sm:items-center sm:justify-between">
          <span>{loadError}</span>
          <Button type="button" variant="outline" onClick={() => reload(false)}>נסה שוב</Button>
        </div>
      )}

      {orders === null && !loadError && (
        <div role="status" className="flex items-center justify-center gap-3 rounded-lg border border-slate-200 bg-white p-8 text-slate-500">
          <Loader2 className="h-5 w-5 animate-spin" aria-hidden /> טוען…
        </div>
      )}

      {orders !== null && orders.length > 0 && (
        <p className="text-sm font-semibold text-slate-600" data-testid="chip-pickup-count">
          {searching
            ? `${visible.length} מתוך ${orders.length} הזמנות מוכנות לאיסוף`
            : orders.length === 1 ? 'הזמנה אחת מוכנה לאיסוף' : `${orders.length} הזמנות מוכנות לאיסוף`}
        </p>
      )}

      {orders !== null && orders.length === 0 && !loadError && (
        <div data-testid="chip-pickup-empty" className="flex flex-col items-center gap-2 rounded-lg border border-dashed border-slate-300 bg-white p-8 text-center">
          <HandHelping className="h-6 w-6 text-slate-400" aria-hidden />
          <div className="text-base font-bold text-slate-900">אין כרגע הזמנות שמוכנות לאיסוף</div>
          <div className="text-sm text-slate-500">הזמנה מופיעה כאן אחרי שההנהלה סימנה אותה „מוכן לאיסוף”.</div>
        </div>
      )}

      {orders !== null && orders.length > 0 && visible.length === 0 && (
        <div data-testid="chip-pickup-no-match" className="flex flex-col items-center gap-2 rounded-lg border border-dashed border-slate-300 bg-white p-8 text-center">
          <Search className="h-6 w-6 text-slate-400" aria-hidden />
          <div className="text-base font-bold text-slate-900">לא נמצאה הזמנה מוכנה עבור „{query.trim()}”</div>
          <div className="text-sm text-slate-500">החיפוש מכסה מספר דירה ושמות האנשים שבהזמנה. הזמנה שעוד לא סומנה „מוכן לאיסוף” לא מופיעה כאן.</div>
        </div>
      )}

      {/* items-start: a card is as tall as its own order — a short one is not
          stretched to the height of the long one beside it. */}
      <div className="grid grid-cols-1 items-start gap-3 lg:grid-cols-2" data-testid="chip-pickup-list">
        {visible.map((o) => (
          <article key={o.id} data-testid="chip-pickup-order" className="flex min-w-0 flex-col gap-4 rounded-lg border border-slate-200 bg-white p-4">
            <header className="flex flex-wrap items-center gap-x-3 gap-y-2">
              <h2 className="text-lg font-extrabold text-slate-900">
                הזמנה <span dir="ltr" className="tabular-nums">{o.order_number}</span>
              </h2>
              <span className="rounded-md bg-slate-100 px-2 py-0.5 text-sm font-bold text-slate-700" data-testid="chip-pickup-apartments">
                {apartmentsText(o.apartments)} <span dir="ltr" className="tabular-nums">{o.apartments.join(', ')}</span>
              </span>
              {o.is_test && (
                <span className="rounded-md border border-violet-200 bg-violet-50 px-2 py-0.5 text-xs font-bold text-violet-700" data-testid="chip-pickup-test">
                  {CHIP_ORDER_TEST_LABEL}
                </span>
              )}
              <span className="ms-auto text-sm font-bold text-slate-600" data-testid="chip-pickup-total">סה״כ {chipsCountText(o.total)}</span>
            </header>

            <ul className="flex flex-col gap-3">
              {o.people.map((p, i) => (
                <li key={`${p.key}-${i}`} data-testid="chip-pickup-person" className="flex min-w-0 flex-col gap-2 rounded-lg bg-slate-50 p-3">
                  <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
                    <span className="min-w-0 break-words text-base font-bold text-slate-900">{p.name}</span>
                    {o.apartments.length > 1 && (
                      <span className="text-sm text-slate-500">דירה <span dir="ltr" className="tabular-nums">{p.apartment}</span></span>
                    )}
                    <span className="ms-auto text-sm font-semibold text-slate-600">{p.chips.length === 0 ? 'אין צ׳יפים' : chipsCountText(p.chips.length)}</span>
                  </div>
                  {p.chips.length > 0 && (
                    <div className="flex flex-wrap gap-2">
                      {p.chips.map((c, k) => (
                        <span key={c.number ?? `app-${k}`} data-testid="chip-pickup-chip"
                          className="inline-flex max-w-full items-center gap-1.5 rounded-md border border-slate-200 bg-white px-2 py-1 text-sm font-bold text-slate-800">
                          {c.number !== null && <span dir="ltr" className="break-all font-mono tabular-nums">{c.number}</span>}
                          {c.type === 'app' && (
                            <span className="inline-flex items-center gap-1 text-xs font-semibold text-slate-500">
                              <Smartphone className="h-3.5 w-3.5" aria-hidden />
                              אפליקציה
                            </span>
                          )}
                        </span>
                      ))}
                    </div>
                  )}
                </li>
              ))}
            </ul>

            {o.total === 0 && (
              <p className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm font-semibold text-amber-800" data-testid="chip-pickup-no-chips">
                להזמנה אין צ׳יפים פעילים למסירה — יש לפנות להנהלה.
              </p>
            )}
            <Button type="button" size="lg" onClick={() => ask(o)} disabled={o.total === 0} className="w-full gap-2" data-testid="chip-pickup-handover">
              <Check className="h-5 w-5" aria-hidden />
              נמסר
            </Button>
          </article>
        ))}
      </div>

      <AlertDialog open={open} onOpenChange={(v) => { if (!saving) setOpen(v); }}>
        <AlertDialogContent dir="rtl" className="p-6" data-testid="chip-pickup-confirm">
          <AlertDialogHeader>
            <AlertDialogTitle>מסירת הזמנה {target?.order_number ?? ''}</AlertDialogTitle>
            <AlertDialogDescription>
              מי הציג תעודה מזהה? בוחרים את האדם מתוך האנשים שבהזמנה.
              {target ? ` יימסרו ${chipsCountText(target.total)}.` : ''}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <CollectorPicker
            people={collectors}
            value={person}
            onChange={setPerson}
            disabled={saving}
            showApartment={(target?.apartments.length ?? 0) > 1}
            testId="chip-pickup-collector"
          />
          <AlertDialogFooter>
            <AlertDialogCancel disabled={saving} className="h-11 px-4">ביטול</AlertDialogCancel>
            <Button type="button" disabled={saving || !person} onClick={() => void handOver()} className="h-11 gap-2 px-4" data-testid="chip-pickup-confirm-button">
              {saving && <Loader2 className="h-4 w-4 animate-spin" aria-hidden />}
              אישור מסירה
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
