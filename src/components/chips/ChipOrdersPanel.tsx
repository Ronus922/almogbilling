'use client';

// /chips → "הזמנות": the OPEN chip orders residents placed on /chip-order,
// ONE ROW PER APARTMENT of an order (13/11/2026). Chips-skin table on desktop,
// cards on a phone — the same anatomy as ChipsTable. A row opens the EXISTING
// issue window (IssueChipSheet) on that apartment, with the orderer's holder
// block and its "פרטי הזמנה" section. A row leaves the tab once its order is
// collected ("נאסף") or rejected ("דחה"). The whole row answers a mouse click;
// for the keyboard and for a screen reader the orderer's NAME is the button
// that opens it — the row itself carries no button role, because a button
// (the quick status step) lives inside it.
// Test orders carry a "בדיקה" badge, can be hidden, are never part of a
// count, and "מחק את כל הזמנות הבדיקה" removes them all.
//
// 24/11/2026 (Ronen):
//   · a search box — by apartment number and by name (the orderer's and the
//     people of the row), "ייצוא לאקסל" and "הדפסה": all three work on the rows
//     the tab holds, nothing is fetched, and whoever sees the tab has them;
//   · a quick status button per row, without opening the window — the order's
//     NEXT step: "מוכן לאיסוף" (only once every chip of the whole order is
//     issued and saved; otherwise off, with the reason written under it) or
//     "נאסף" (a ready order). Each asks first. The same routes, permission
//     (chips_orders_manage:edit), messages and audit rows as the window's
//     buttons; "דחה" and "מחק הזמנת בדיקה" stay inside the window.

import { useEffect, useMemo, useState } from 'react';
import { toast } from 'sonner';
import { AlertTriangle, Check, CheckCheck, FileSpreadsheet, FlaskConical, Inbox, Loader2, Printer, Search } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  AlertDialog, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter,
  AlertDialogHeader, AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { cn } from '@/lib/utils';
import { e164ToLocal } from '@/lib/portal/phone';
import {
  CHIP_ORDER_ROLE_LABEL, chipOrderStage, isChipOrderOverdue, type ChipOrderRow,
} from '@/lib/chipOrders/model';
import {
  chipOrderRowAction, filterChipOrderRows, searchHitPeople, summarizeChipOrders, type ChipOrderRowAction,
} from '@/lib/chipOrders/orderRows';
import { exportChipOrdersExcel } from '@/lib/export/chip-orders-export';
import { ChipOrderStagePill, ChipOrderTestBadge, ChipOrderUnverifiedPhoneBadge } from './ChipOrderStatusPill';
import { PrintableChipOrders } from './PrintableChipOrders';

// מזמין · דירה · כמות · תאריך הזמנה · סטטוס (· פעולה — with chips_orders_manage:edit)
const COLS = 'grid-cols-[1.8fr_0.8fr_0.7fr_0.9fr_1.4fr]';
const COLS_ACT = 'grid-cols-[1.8fr_0.8fr_0.7fr_0.9fr_1.4fr_1.25fr]';
const HEAD_CELL = 'text-[12px] font-bold uppercase tracking-[0.02em] text-[var(--chip-ink-soft)]';
// The action column stays in sight: where the card is narrower than the table
// (a 1024–1280px window with the menu panel open) the table scrolls sideways
// inside the card, and this cell holds on to the card's far edge instead of
// leaving with the rest. Its box reaches through the row's own padding
// (-me-6 / pe-6), so nothing shows between it and the edge. Only while the
// card really is narrower than the table (900px) the cell carries a hairline
// and a soft shadow on its start side — what scrolls under it reads as under.
const ACT_CELL =
  'sticky end-0 z-[1] -me-6 self-stretch pe-6 ps-3 flex items-center @max-[899px]:border-s @max-[899px]:border-[var(--chip-border)] @max-[899px]:shadow-[10px_0_14px_-12px_rgba(20,27,52,0.28)]';
// One line always: on the narrowest phones (under ~340px) the two buttons do
// not fit side by side, so their row wraps and each takes a line of its own.
const TOOL_BTN =
  'inline-flex h-11 cursor-pointer items-center gap-2 whitespace-nowrap rounded-[11px] border-[1.5px] border-[var(--chip-border)] bg-[var(--chip-panel)] px-3 text-[13.5px] font-semibold text-[var(--chip-ink-muted)] transition-colors hover:bg-[var(--chip-hover)] disabled:cursor-not-allowed disabled:opacity-50 sm:px-4';

const DATE = new Intl.DateTimeFormat('he-IL', { timeZone: 'Asia/Jerusalem', day: '2-digit', month: '2-digit', year: '2-digit' });

type StatusStep = 'ready' | 'collected';

/** The orderer's name. Where rows open the issue window it is a real button —
 *  the row's handle for the keyboard and for assistive technology. */
function OrdererName({ name, onOpen, className }: { name: string; onOpen?: () => void; className: string }) {
  if (!onOpen) return <span className={className}>{name}</span>;
  return (
    <button
      type="button"
      onClick={(e) => { e.stopPropagation(); onOpen(); }}
      className={cn(className, 'cursor-pointer rounded-[4px] text-start focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--chip-brand)]')}
    >
      {name}
    </button>
  );
}

/** The quick status button of one row. The click and the keys stop here: the
 *  row behind it opens the issue window, and this button must not. */
function RowAction({
  action, wide, onAsk,
}: {
  action: ChipOrderRowAction;
  /** A phone card: the button fills the card's width and is 44px tall. */
  wide: boolean;
  onAsk: (step: StatusStep) => void;
}) {
  const ready = action.kind === 'ready';
  const off = ready && !action.enabled;
  return (
    <span
      className={cn('inline-flex flex-col gap-1', wide ? 'w-full items-stretch' : 'items-start')}
      onClick={(e) => e.stopPropagation()}
      onKeyDown={(e) => e.stopPropagation()}
    >
      <button
        type="button"
        disabled={off}
        onClick={() => onAsk(action.kind)}
        data-testid={ready ? 'chip-order-row-ready' : 'chip-order-row-collected'}
        className={cn(
          'relative inline-flex cursor-pointer items-center justify-center gap-1.5 whitespace-nowrap rounded-[9px] px-3 text-[13px] font-bold text-white transition-colors disabled:cursor-not-allowed disabled:opacity-45',
          // 36px in the table, with a 44px hit area around it; 44px on a card.
          wide ? 'h-11' : "h-9 after:absolute after:inset-x-0 after:-inset-y-1 after:content-['']",
          ready
            ? 'bg-[var(--chip-brand)] hover:bg-[var(--chip-brand-hover)] disabled:hover:bg-[var(--chip-brand)]'
            : 'bg-[var(--chip-green)] hover:bg-[var(--chip-green-ink)]',
        )}
      >
        {ready ? <Check className="h-4 w-4" strokeWidth={2.4} /> : <CheckCheck className="h-4 w-4" strokeWidth={2.2} />}
        {ready ? 'מוכן לאיסוף' : 'נאסף'}
      </button>
      {/* Why the button is off — written out, not left to a tooltip. */}
      {ready && action.reason && (
        <span data-testid="chip-order-row-reason" className="text-[11.5px] font-semibold leading-[1.35] text-[var(--chip-amber-ink)]">
          {action.reason}
        </span>
      )}
    </span>
  );
}

export function ChipOrdersPanel({
  items, loading, onOpen, canEdit = false, unfinishedTests = 0, onChanged,
}: {
  items: ChipOrderRow[];
  loading: boolean;
  /** Opens the issue window on the row's apartment; absent = rows are not
   *  clickable (no chips:edit). */
  onOpen?: (row: ChipOrderRow) => void;
  /** chips_orders_manage:edit — the quick status button of a row, and
   *  "מחק את כל הזמנות הבדיקה". */
  canEdit?: boolean;
  /** Test orders never finished (not in `items`) — deleted with the rest. */
  unfinishedTests?: number;
  /** Something changed on the server — load the rows again (in place). */
  onChanged?: () => void | Promise<void>;
}) {
  const [showTests, setShowTests] = useState(true);
  const [query, setQuery] = useState('');
  const [deleteAllOpen, setDeleteAllOpen] = useState(false);
  const [deleting, setDeleting] = useState(false);
  // The quick status button: what is being asked (kept while the dialog
  // closes, so its text does not change on the way out) and whether it is open.
  const [ask, setAsk] = useState<{ step: StatusStep; row: ChipOrderRow } | null>(null);
  const [askOpen, setAskOpen] = useState(false);
  const [acting, setActing] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [printRows, setPrintRows] = useState<ChipOrderRow[] | null>(null);

  const tests = useMemo(() => items.filter((o) => o.is_test), [items]);
  // The status belongs to the whole order: what a row may do is read from ALL
  // the order's rows, also the ones the search or the tests switch hides.
  const summaries = useMemo(() => summarizeChipOrders(items), [items]);
  const shown = useMemo(() => items.filter((o) => showTests || !o.is_test), [items, showTests]);
  const visible = useMemo(() => filterChipOrderRows(shown, query), [shown, query]);
  const searching = query.trim() !== '';
  const testOrders = new Set(tests.map((o) => o.order_id)).size;
  const testCount = testOrders + unfinishedTests;
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
      void onChanged?.();
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setDeleting(false);
    }
  }

  /** "מוכן לאיסוף" / "נאסף" of a row, after the confirmation: the same routes
   *  the window's buttons call. The rows are loaded again either way — after a
   *  refusal too, since a refusal means the order moved behind this screen. */
  async function runStatusStep() {
    if (!ask) return;
    setActing(true);
    try {
      const res = await fetch(`/api/chip-orders/${ask.row.order_id}/${ask.step}`, { method: 'POST', credentials: 'include' });
      const data = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) throw new Error(data.error === 'not_found' ? 'ההזמנה לא נמצאה' : data.error ?? 'הפעולה נכשלה');
      toast.success(ask.step === 'ready' ? 'סומן מוכן לאיסוף — נשלחה הודעה למזמין' : 'סומן כנאסף');
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      await onChanged?.();
      setActing(false);
      setAskOpen(false);
    }
  }

  async function exportExcel() {
    if (exporting || visible.length === 0) return;
    setExporting(true);
    try {
      await exportChipOrdersExcel(visible);
    } catch {
      toast.error('הייצוא לאקסל נכשל');
    } finally {
      setExporting(false);
    }
  }

  // Once the print-only table is in the DOM, open the print dialog. The table
  // is taken down when the browser says the printing is over (`afterprint`),
  // not when print() returns: where print() does not wait for the dialog (a
  // phone), the page would be printed after the table is already gone.
  useEffect(() => {
    if (!printRows) return;
    const done = () => setPrintRows(null);
    window.addEventListener('afterprint', done);
    const t = setTimeout(() => window.print(), 80);
    return () => {
      clearTimeout(t);
      window.removeEventListener('afterprint', done);
    };
  }, [printRows]);

  // Mouse only — see the note at the top of the file (the name is the button).
  const rowProps = (o: ChipOrderRow) => (onOpen ? { onClick: () => onOpen(o) } : {});

  const actionOf = (o: ChipOrderRow) => (canEdit ? chipOrderRowAction(o, summaries.get(o.order_id)) : null);
  const askFor = (o: ChipOrderRow) => (step: StatusStep) => { setAsk({ step, row: o }); setAskOpen(true); };
  const cols = canEdit ? COLS_ACT : COLS;
  const askApartments = ask ? summaries.get(ask.row.order_id)?.apartments ?? [] : [];

  return (
    // mb-16 with the quick buttons: the card is the LAST thing on the page, and
    // its buttons sit at the far edge — the corner of the assistant's floating
    // button (AgentFab, fixed bottom-6 left-6, 56px). Scrolled to the end, the
    // last row rises above it (the same room the paging control of other
    // screens leaves under itself).
    <div className={cn('overflow-hidden rounded-[16px] border border-[var(--chip-border)] bg-[var(--chip-panel)]', canEdit && 'mb-16')}>
      {/* Toolbar: the test-orders controls (only while there are any) · search · Excel · print */}
      <div className="flex flex-wrap items-center gap-3 border-b border-[var(--chip-border)] px-[22px] py-4">
        {testCount > 0 && (
          <div className="flex flex-wrap items-center gap-2">
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
          </div>
        )}
        {/* Pushed to the far end; drops to a line of its own when the card is too narrow for both groups. */}
        <div className="flex w-full flex-col gap-2 sm:ms-auto sm:w-auto sm:flex-row sm:items-center">
          <div className="relative w-full sm:w-[280px]">
            <Search className="pointer-events-none absolute start-[13px] top-1/2 h-[17px] w-[17px] -translate-y-1/2 text-[var(--chip-ink-soft)]" />
            <Input
              type="search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="חפש לפי דירה או שם"
              aria-label="חיפוש בהזמנות לפי מספר דירה או שם"
              data-testid="chip-orders-search"
              className="h-11 rounded-[11px] border-[1.5px] border-[var(--chip-border)] bg-[var(--chip-panel)] ps-[42px] pe-[14px] text-[14px] placeholder:text-[var(--chip-ink-soft)] focus-visible:border-[var(--chip-brand)] focus-visible:ring-4 focus-visible:ring-[rgba(61,90,254,0.12)]"
            />
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <button type="button" className={cn(TOOL_BTN, 'flex-1 justify-center sm:flex-none')} onClick={() => void exportExcel()} disabled={loading || exporting || visible.length === 0}
              data-testid="chip-orders-export">
              {exporting ? <Loader2 className="h-4 w-4 shrink-0 animate-spin" /> : <FileSpreadsheet className="h-4 w-4 shrink-0" />}
              ייצוא לאקסל
            </button>
            <button type="button" className={cn(TOOL_BTN, 'flex-1 justify-center sm:flex-none')} onClick={() => setPrintRows([...visible])} disabled={loading || visible.length === 0}
              data-testid="chip-orders-print">
              <Printer className="h-4 w-4 shrink-0" />
              הדפסה
            </button>
          </div>
        </div>
      </div>

      {loading ? (
        <div className="space-y-2 p-4">
          {Array.from({ length: 4 }).map((_, i) => (
            <div key={i} className="h-12 animate-pulse rounded-lg bg-muted/60" />
          ))}
        </div>
      ) : shown.length === 0 ? (
        <div className="flex flex-col items-center gap-3 p-12 text-center">
          <span className="grid h-12 w-12 place-items-center rounded-full bg-[var(--chip-hover)] text-[var(--chip-ink-soft)]">
            <Inbox className="h-5 w-5" />
          </span>
          <p className="text-[15px] font-bold text-[var(--chip-ink)]">אין הזמנות פתוחות</p>
          <p className="text-[13px] font-medium text-[var(--chip-ink-soft)]">הזמנה מופיעה כאן אחרי שהתשלום אושר, ויוצאת כשהיא נאספת או נדחית.</p>
        </div>
      ) : visible.length === 0 ? (
        // Search-empty is not table-empty (as in the chips tab).
        <div className="flex flex-col items-center gap-3 p-12 text-center" data-testid="chip-orders-no-match">
          <span className="grid h-12 w-12 place-items-center rounded-full bg-[var(--chip-hover)] text-[var(--chip-ink-soft)]">
            <Search className="h-5 w-5" />
          </span>
          <p className="text-[15px] font-bold text-[var(--chip-ink)]">אין הזמנות עבור „{query.trim()}”</p>
          <p className="text-[13px] font-medium text-[var(--chip-ink-soft)]">החיפוש מכסה מספר דירה, שם המזמין ושמות בעלי הצ׳יפ שבהזמנה.</p>
        </div>
      ) : (
        <>
          {/* Desktop table */}
          <div className="@container hidden overflow-x-auto sm:block">
            <div className={canEdit ? 'min-w-[900px]' : 'min-w-[760px]'} data-testid="chip-orders-table">
              <div className={cn('grid items-center gap-3 border-b border-[var(--chip-border)] bg-[var(--chip-panel-alt)] px-6 py-[13px]', cols)}>
                <span className={HEAD_CELL}>מזמין</span>
                <span className={HEAD_CELL}>דירה</span>
                <span className={cn(HEAD_CELL, 'text-center')}>כמות</span>
                <span className={HEAD_CELL}>תאריך הזמנה</span>
                <span className={HEAD_CELL}>סטטוס</span>
                {canEdit && <span className={cn(HEAD_CELL, ACT_CELL, '-my-[13px] bg-[var(--chip-panel-alt)] py-[13px]')}>פעולה</span>}
              </div>
              {visible.map((o) => {
                const action = actionOf(o);
                const hits = searching ? searchHitPeople(o, query) : [];
                return (
                  <div
                    key={o.item_id}
                    data-testid="chip-order-row"
                    {...rowProps(o)}
                    className={cn(
                      'group grid min-h-[58px] items-center gap-3 border-b border-[var(--chip-border)] px-6 py-[12px] transition-colors last:border-0',
                      onOpen && 'cursor-pointer hover:bg-[var(--chip-hover)]',
                      cols,
                    )}
                  >
                    <span className="flex min-w-0 flex-col gap-[2px]">
                      <span className="flex min-w-0 items-center gap-1.5">
                        <OrdererName name={o.full_name} onOpen={onOpen && (() => onOpen(o))} className="truncate text-[14.5px] font-bold text-[var(--chip-ink)]" />
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
                      {hits.length > 0 && (
                        <span className="truncate text-[12px] font-semibold text-[var(--chip-brand-ink)]" data-testid="chip-order-row-hit">
                          בעל צ׳יפ בהזמנה: {hits.join(', ')}
                        </span>
                      )}
                    </span>
                    <span className="chip-num text-[14px] font-bold text-[var(--chip-ink)]">{o.apartment_number}</span>
                    <span className="chip-num text-center text-[14px] font-bold text-[var(--chip-ink-muted)]">{o.chips_count}</span>
                    <span className="chip-num text-[13px] font-semibold text-[var(--chip-ink-muted)]">{DATE.format(new Date(o.created_at))}</span>
                    <span>
                      <ChipOrderStagePill
                        stage={chipOrderStage(o.status, o.chips_linked, o.chips_count)}
                        linked={o.chips_linked}
                        ordered={o.chips_count}
                        overdue={isChipOrderOverdue(o)}
                      />
                    </span>
                    {canEdit && (
                      <span className={cn(ACT_CELL, '-my-[12px] bg-[var(--chip-panel)] py-[12px] transition-colors', onOpen && 'group-hover:bg-[var(--chip-hover)]')}>
                        {action && <RowAction action={action} wide={false} onAsk={askFor(o)} />}
                      </span>
                    )}
                  </div>
                );
              })}
            </div>
          </div>

          {/* Phone cards */}
          <div className="space-y-2 p-4 sm:hidden">
            {visible.map((o) => {
              const action = actionOf(o);
              const hits = searching ? searchHitPeople(o, query) : [];
              return (
                <div
                  key={o.item_id}
                  data-testid="chip-order-card"
                  {...rowProps(o)}
                  className={cn(
                    'flex w-full flex-col gap-2 rounded-[13px] border border-[var(--chip-border)] bg-[var(--chip-panel)] p-4 text-start transition-colors',
                    onOpen && 'cursor-pointer hover:bg-[var(--chip-hover)]',
                  )}
                >
                  <span className="flex w-full items-center gap-2">
                    <OrdererName name={o.full_name} onOpen={onOpen && (() => onOpen(o))} className="min-w-0 flex-1 truncate text-[15px] font-bold text-[var(--chip-ink)]" />
                    {o.is_test && <ChipOrderTestBadge />}
                    {!o.phone_verified && <ChipOrderUnverifiedPhoneBadge />}
                  </span>
                  <span className="text-[12.5px] font-semibold text-[var(--chip-ink-muted)]">
                    דירה <span className="chip-num">{o.apartment_number}</span> · {o.chips_count} צ׳יפים · {DATE.format(new Date(o.created_at))}
                  </span>
                  {hits.length > 0 && (
                    <span className="text-[12px] font-semibold text-[var(--chip-brand-ink)]">בעל צ׳יפ בהזמנה: {hits.join(', ')}</span>
                  )}
                  <ChipOrderStagePill
                    stage={chipOrderStage(o.status, o.chips_linked, o.chips_count)}
                    linked={o.chips_linked}
                    ordered={o.chips_count}
                    overdue={isChipOrderOverdue(o)}
                  />
                  {action && <RowAction action={action} wide onAsk={askFor(o)} />}
                </div>
              );
            })}
          </div>
        </>
      )}

      {/* "מוכן לאיסוף" / "נאסף" of a row — asked first. */}
      <AlertDialog open={askOpen} onOpenChange={(o) => { if (!acting) setAskOpen(o); }}>
        <AlertDialogContent dir="rtl" className="chips-skin" data-testid="chip-order-row-confirm">
          <AlertDialogHeader>
            <AlertDialogTitle>
              {ask?.step === 'collected' ? `לסמן את הזמנה ${ask.row.order_number} כנאספה?` : `לסמן את הזמנה ${ask?.row.order_number ?? ''} כמוכנה לאיסוף?`}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {ask?.step === 'collected'
                ? 'ההזמנה תצא מרשימת ההזמנות הפתוחות. לא נשלחת הודעה למזמין.'
                : `תישלח הודעה למזמין, ${ask?.row.full_name ?? ''}, במייל ובוואטסאפ: הצ׳יפים מוכנים לאיסוף.`}
              {askApartments.length > 1 && ` הסימון חל על ההזמנה כולה — דירות ${askApartments.join(', ')}.`}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={acting} className="h-11 px-4">ביטול</AlertDialogCancel>
            <Button
              type="button"
              disabled={acting}
              onClick={() => void runStatusStep()}
              className={cn(
                'h-11 gap-2 px-4 text-white',
                ask?.step === 'collected'
                  ? 'bg-[var(--chip-green)] hover:bg-[var(--chip-green-ink)]'
                  : 'bg-[var(--chip-brand)] hover:bg-[var(--chip-brand-hover)]',
              )}
            >
              {acting && <Loader2 className="h-4 w-4 animate-spin" />}
              {ask?.step === 'collected' ? 'סמן כנאסף' : 'סמן מוכן לאיסוף'}
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

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

      {printRows && <PrintableChipOrders rows={printRows} query={query} />}
    </div>
  );
}
