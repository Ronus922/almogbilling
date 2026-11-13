'use client';

// /chips → "הזמנות" (12/11/2026): the PAID chip orders residents placed on
// /chip-order. Chips-skin table on desktop, cards on a phone — the same
// anatomy as ChipsTable. A row opens the order panel (ChipOrderSheet).
// Test orders (13/11/2026) carry a "בדיקה" badge, can be hidden, are never
// part of a count, and "מחק את כל הזמנות הבדיקה" removes them all.

import { useMemo, useState } from 'react';
import { toast } from 'sonner';
import { AlertTriangle, FlaskConical, Inbox, Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  AlertDialog, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter,
  AlertDialogHeader, AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { cn } from '@/lib/utils';
import { e164ToLocal } from '@/lib/portal/phone';
import {
  CHIP_ORDER_ROLE_LABEL, formatIls, isChipOrderOverdue, type ChipOrderListItem, type ChipOrderStatus,
} from '@/lib/chipOrders/model';
import { ChipOrderStatusPill, ChipOrderTestBadge, ChipOrderUnverifiedPhoneBadge } from './ChipOrderStatusPill';

type Filter = 'open' | 'all' | 'collected' | 'rejected';

const FILTERS: { value: Filter; label: string; statuses: ChipOrderStatus[] | null }[] = [
  { value: 'open', label: 'בטיפול', statuses: ['paid', 'approved', 'ready'] },
  { value: 'all', label: 'הכל', statuses: null },
  { value: 'collected', label: 'נאספו', statuses: ['collected'] },
  { value: 'rejected', label: 'נדחו', statuses: ['rejected'] },
];

// הזמנה · מזמין · דירות · צ׳יפים · סכום · סטטוס · יעד
const COLS = 'grid-cols-[0.9fr_1.6fr_1fr_0.7fr_0.7fr_1.3fr_1fr]';
const HEAD_CELL = 'text-[12px] font-bold uppercase tracking-[0.02em] text-[var(--chip-ink-soft)]';

const DATE = new Intl.DateTimeFormat('he-IL', { timeZone: 'Asia/Jerusalem', day: '2-digit', month: '2-digit', year: '2-digit' });
const DATE_TIME = new Intl.DateTimeFormat('he-IL', {
  timeZone: 'Asia/Jerusalem', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit',
});

export function ChipOrdersPanel({
  items, loading, onOpen, canEdit = false, unfinishedTests = 0, onChanged,
}: {
  items: ChipOrderListItem[];
  loading: boolean;
  onOpen: (id: string) => void;
  /** chips_orders_manage:edit — offers "מחק את כל הזמנות הבדיקה". */
  canEdit?: boolean;
  /** Test orders never finished (not in `items`) — deleted with the rest. */
  unfinishedTests?: number;
  onChanged?: () => void;
}) {
  const [filter, setFilter] = useState<Filter>('open');
  const [showTests, setShowTests] = useState(true);
  const [deleteAllOpen, setDeleteAllOpen] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const tests = useMemo(() => items.filter((o) => o.is_test), [items]);
  const visible = useMemo(() => {
    const f = FILTERS.find((x) => x.value === filter)?.statuses ?? null;
    return items.filter((o) => (showTests || !o.is_test) && (!f || f.includes(o.status)));
  }, [items, filter, showTests]);
  // Test orders are never counted (nor summed) — only shown, when asked.
  const counts = useMemo(() => {
    const real = items.filter((o) => !o.is_test);
    const c: Record<Filter, number> = { open: 0, all: real.length, collected: 0, rejected: 0 };
    for (const o of real) {
      if (o.status === 'collected') c.collected++;
      else if (o.status === 'rejected') c.rejected++;
      else c.open++;
    }
    return c;
  }, [items]);
  const testCount = tests.length + unfinishedTests;
  const testActiveChips = tests.reduce((n, o) => n + o.chips_linked, 0);

  async function deleteAllTests() {
    setDeleting(true);
    try {
      const res = await fetch('/api/chip-orders/test-orders', { method: 'DELETE', credentials: 'include' });
      const data = (await res.json().catch(() => ({}))) as { deleted?: number; fileFailed?: number; error?: string };
      if (!res.ok) throw new Error(data.error ?? 'המחיקה נכשלה');
      if (data.fileFailed) toast.warning(`נמחקו ${data.deleted ?? 0} הזמנות בדיקה; ${data.fileFailed} נשארו כי קובץ החוזה לא נמחק — נסו שוב.`);
      else toast.success(data.deleted ? `נמחקו ${data.deleted} הזמנות בדיקה` : 'לא נמצאו הזמנות בדיקה');
      setDeleteAllOpen(false);
      onChanged?.();
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setDeleting(false);
    }
  }

  return (
    <div className="overflow-hidden rounded-[16px] border border-[var(--chip-border)] bg-[var(--chip-panel)]">
      <div className="flex flex-wrap items-center gap-2 border-b border-[var(--chip-border)] px-[22px] py-4">
        {FILTERS.map((f) => (
          <button
            key={f.value}
            type="button"
            onClick={() => setFilter(f.value)}
            className={cn(
              'inline-flex h-11 cursor-pointer items-center gap-1.5 rounded-full px-4 text-[13.5px] transition-colors sm:h-9',
              filter === f.value
                ? 'bg-[var(--chip-brand)] font-bold text-white'
                : 'border-[1.5px] border-[var(--chip-border)] bg-[var(--chip-panel)] font-semibold text-[var(--chip-ink-muted)] hover:bg-[var(--chip-hover)]',
            )}
          >
            {f.label}
            <span className={cn('chip-num text-[12px]', filter === f.value ? 'text-white/80' : 'text-[var(--chip-ink-soft)]')}>
              {counts[f.value]}
            </span>
          </button>
        ))}
        {testCount > 0 && (
          <span className="flex flex-wrap items-center gap-2 sm:ms-auto">
            <button
              type="button"
              aria-pressed={showTests}
              onClick={() => setShowTests((v) => !v)}
              data-testid="chip-orders-toggle-tests"
              className={cn(
                'inline-flex h-11 cursor-pointer items-center gap-1.5 rounded-full border-[1.5px] px-4 text-[13.5px] font-semibold transition-colors sm:h-9',
                showTests
                  ? 'border-[var(--chip-violet-border)] bg-[var(--chip-violet-soft)] text-[var(--chip-violet-ink)]'
                  : 'border-[var(--chip-border)] bg-[var(--chip-panel)] text-[var(--chip-ink-muted)] hover:bg-[var(--chip-hover)]',
              )}
            >
              <FlaskConical className="h-4 w-4" />
              {showTests ? 'הסתר הזמנות בדיקה' : 'הצג הזמנות בדיקה'}
            </button>
            {canEdit && (
              <button
                type="button"
                onClick={() => setDeleteAllOpen(true)}
                data-testid="chip-orders-delete-all-tests"
                className="inline-flex h-11 cursor-pointer items-center rounded-full border-[1.5px] border-[var(--chip-red-border)] bg-[var(--chip-panel)] px-4 text-[13.5px] font-semibold text-[var(--chip-red-ink)] transition-colors hover:bg-[var(--chip-red-soft)] sm:h-9"
              >
                מחק את כל הזמנות הבדיקה
              </button>
            )}
          </span>
        )}
      </div>

      {loading ? (
        <div className="space-y-2 p-4">
          {Array.from({ length: 4 }).map((_, i) => (
            <div key={i} className="h-12 animate-pulse rounded-lg bg-muted/60" />
          ))}
        </div>
      ) : visible.length === 0 ? (
        <div className="flex flex-col items-center gap-3 p-12 text-center">
          <span className="grid h-12 w-12 place-items-center rounded-full bg-[var(--chip-hover)] text-[var(--chip-ink-soft)]">
            <Inbox className="h-5 w-5" />
          </span>
          <p className="text-[15px] font-bold text-[var(--chip-ink)]">אין הזמנות להצגה</p>
          <p className="text-[13px] font-medium text-[var(--chip-ink-soft)]">הזמנות מופיעות כאן רק אחרי שהתשלום אושר.</p>
        </div>
      ) : (
        <>
          {/* Desktop table */}
          <div className="hidden overflow-x-auto sm:block">
            <div className="min-w-[900px]" data-testid="chip-orders-table">
              <div className={cn('grid items-center gap-3 border-b border-[var(--chip-border)] bg-[var(--chip-panel-alt)] px-6 py-[13px]', COLS)}>
                <span className={HEAD_CELL}>הזמנה</span>
                <span className={HEAD_CELL}>מזמין</span>
                <span className={HEAD_CELL}>דירות</span>
                <span className={cn(HEAD_CELL, 'text-center')}>צ׳יפים</span>
                <span className={cn(HEAD_CELL, 'text-center')}>סכום</span>
                <span className={HEAD_CELL}>סטטוס</span>
                <span className={HEAD_CELL}>יעד</span>
              </div>
              {visible.map((o) => {
                const overdue = isChipOrderOverdue(o);
                return (
                  <div
                    key={o.id}
                    role="button"
                    tabIndex={0}
                    onClick={() => onOpen(o.id)}
                    onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onOpen(o.id); } }}
                    className={cn('grid min-h-[58px] cursor-pointer items-center gap-3 border-b border-[var(--chip-border)] px-6 py-[12px] transition-colors last:border-0 hover:bg-[var(--chip-hover)]', COLS)}
                  >
                    <span className="flex flex-col">
                      <span className="chip-num text-[14px] font-bold text-[var(--chip-ink)]">{o.order_number}</span>
                      <span className="text-[12px] font-medium text-[var(--chip-ink-soft)]">{o.paid_at ? DATE.format(new Date(o.paid_at)) : '—'}</span>
                    </span>
                    <span className="flex min-w-0 flex-col gap-[2px]">
                      <span className="flex min-w-0 items-center gap-1.5">
                        <span className="truncate text-[14.5px] font-bold text-[var(--chip-ink)]">{o.full_name}</span>
                        {o.is_test && <ChipOrderTestBadge />}
                        {!o.phone_verified && <ChipOrderUnverifiedPhoneBadge />}
                        {o.has_failed_notification && (
                          <span title="שליחת הודעה נכשלה" className="shrink-0 text-[var(--chip-red)]">
                            <AlertTriangle className="h-4 w-4" />
                          </span>
                        )}
                      </span>
                      <span className="text-[12.5px] font-semibold text-[var(--chip-ink-muted)]">
                        {CHIP_ORDER_ROLE_LABEL[o.role]} · <span className="chip-num">{e164ToLocal(o.phone_e164)}</span>
                      </span>
                    </span>
                    <span className="truncate text-[13.5px] font-semibold text-[var(--chip-ink)]" title={o.apartments.join(', ')}>
                      {o.apartments.join(', ')}
                    </span>
                    <span className="chip-num text-center text-[13.5px] font-bold text-[var(--chip-ink-muted)]">
                      {o.chips_linked}/{o.chips_total}
                    </span>
                    <span className="text-center text-[13.5px] font-bold text-[var(--chip-ink)]">{formatIls(o.total)}</span>
                    <span><ChipOrderStatusPill status={o.status} overdue={overdue} /></span>
                    <span className={cn('text-[12.5px] font-semibold', overdue ? 'text-[var(--chip-red-ink)]' : 'text-[var(--chip-ink-muted)]')}>
                      {o.status === 'approved' && o.due_at ? DATE_TIME.format(new Date(o.due_at)) : '—'}
                    </span>
                  </div>
                );
              })}
            </div>
          </div>

          {/* Phone cards */}
          <div className="space-y-2 p-4 sm:hidden">
            {visible.map((o) => {
              const overdue = isChipOrderOverdue(o);
              return (
                <button
                  key={o.id}
                  type="button"
                  onClick={() => onOpen(o.id)}
                  className="flex w-full flex-col gap-2 rounded-[13px] border border-[var(--chip-border)] bg-[var(--chip-panel)] p-4 text-start transition-colors hover:bg-[var(--chip-hover)]"
                >
                  <span className="flex w-full items-center gap-2">
                    <span className="chip-num text-[13px] font-bold text-[var(--chip-ink-muted)]">{o.order_number}</span>
                    <span className="min-w-0 flex-1 truncate text-[15px] font-bold text-[var(--chip-ink)]">{o.full_name}</span>
                    {o.is_test && <ChipOrderTestBadge />}
                    {!o.phone_verified && <ChipOrderUnverifiedPhoneBadge />}
                    <span className="text-[14px] font-bold text-[var(--chip-ink)]">{formatIls(o.total)}</span>
                  </span>
                  <span className="text-[12.5px] font-semibold text-[var(--chip-ink-muted)]">
                    {CHIP_ORDER_ROLE_LABEL[o.role]} · דירות {o.apartments.join(', ')} · צ׳יפים {o.chips_linked}/{o.chips_total}
                  </span>
                  <ChipOrderStatusPill status={o.status} overdue={overdue} />
                </button>
              );
            })}
          </div>
        </>
      )}

      <AlertDialog open={deleteAllOpen} onOpenChange={(o) => { if (!deleting) setDeleteAllOpen(o); }}>
        <AlertDialogContent dir="rtl" className="chips-skin">
          <AlertDialogHeader>
            <AlertDialogTitle>למחוק את כל הזמנות הבדיקה?</AlertDialogTitle>
            <AlertDialogDescription>
              {`${testCount === 1 ? 'הזמנת בדיקה אחת תימחק' : `${testCount} הזמנות בדיקה יימחקו`} לצמיתות, עם הדירות, ההודעות וקובצי החוזה. הזמנות רגילות לא נפגעות. צ׳יפים שהונפקו להזמנות הבדיקה נשארים במודול הצ׳יפים, רק בלי הקישור להזמנה.`}
            </AlertDialogDescription>
          </AlertDialogHeader>
          {testActiveChips > 0 && (
            <p role="alert" className="flex items-start gap-2 rounded-[11px] border border-[var(--chip-amber-border)] bg-[var(--chip-amber-soft)] p-3 text-[13.5px] font-semibold text-[var(--chip-amber-ink)]">
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
              {testActiveChips === 1 ? 'להזמנות הבדיקה צ׳יפ פעיל אחד' : `להזמנות הבדיקה ${testActiveChips} צ׳יפים פעילים`}. הם לא יימחקו — השביתו אותם בחלון ההנפקה של הדירה.
            </p>
          )}
          <AlertDialogFooter>
            <AlertDialogCancel disabled={deleting} className="h-11 px-4">ביטול</AlertDialogCancel>
            <Button
              type="button"
              disabled={deleting}
              onClick={() => void deleteAllTests()}
              className="h-11 gap-2 bg-destructive px-4 text-white hover:bg-destructive/90"
            >
              {deleting && <Loader2 className="h-4 w-4 animate-spin" />}
              מחק את כל הזמנות הבדיקה
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
