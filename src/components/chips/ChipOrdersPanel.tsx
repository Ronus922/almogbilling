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
// Test orders carry a "בדיקה" tag, can be hidden, are never part of a count,
// and "מחק את כל הזמנות הבדיקה" removes them all.
//
// 24/11/2026 (Ronen):
//   · a search box — by apartment number and by name (the orderer's and the
//     people of the row) — "ייצוא לאקסל" and "הדפסה": all work on the rows the
//     tab holds, nothing is fetched, and whoever sees the tab has them;
//   · the action column — the order's NEXT step, without opening the window:
//     "מוכן לאיסוף" once every chip of the whole order is issued and saved,
//     "נאסף" for a ready order; each asks first. The same routes, permission
//     (chips_orders_manage:edit), messages and audit rows as the window's
//     buttons; "דחה" and "מחק הזמנת בדיקה" stay inside the window.
// 25/11/2026 (Ronen):
//   · while chips are missing the action column holds NO button: a plain label
//     "בהמתנה" with what is missing under it — a dimmed "מוכן לאיסוף" read as
//     if the order were ready;
//   · tags ("בדיקה", "טלפון לא אומת", "הודעה נכשלה") have a column of their
//     own, so the orderer's column is the name with the role and the phone
//     under it, and nothing else;
//   · every value sits under its header — see the note above COLS;
//   · the toolbar and its three buttons — "הדפסה", "ייצוא לאקסל",
//     "הורדה ל-PDF" — are the chips tab's too (ChipsToolbar, ChipListExports).

import { useMemo, useState } from 'react';
import { toast } from 'sonner';
import { AlertTriangle, Check, CheckCheck, FlaskConical, Hourglass, Inbox, Loader2, Search } from 'lucide-react';
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
  CHIP_ORDERS_EXPORT, CHIP_ORDER_WAITING_LABEL, chipOrderRowAction, chipOrderRowTags, filterChipOrderRows, searchHitPeople,
  summarizeChipOrders, type ChipOrderRowAction,
} from '@/lib/chipOrders/orderRows';
import { ChipListExports } from './ChipListExports';
import { CHIPS_SEARCH_INPUT, ChipsToolbar } from './ChipsToolbar';
import { ChipOrderStagePill } from './ChipOrderStatusPill';
import { ChipOrderTags } from './ChipOrderTags';

// מזמין · תגיות · דירה · כמות · תאריך הזמנה · סטטוס (· פעולה — with chips_orders_manage:edit)
//
// A VALUE SITS UNDER ITS HEADER (25/11/2026). The header row and every body
// row are grids of their own, so they agree on the columns only if no track
// is sized by what it holds. Every track here is a fixed width, or a share of
// the row with a floor of its own — minmax(px, fr), never a bare `fr`, whose
// floor is its content: one long name or a wide button would then push the
// columns of that row alone. And a column has ONE alignment, written once in
// COL and worn by its header cell and by its body cells alike: text columns
// from the start edge, the three number columns centred.
// The floors, with the row's gaps and padding, must fit the table's minimum
// width — or the last column sticks out of the row. The root font is 17px, so
// gap-3 is 12.75px and px-6 is 25.5px (not 12 and 24): with the action column
// 772 + 6 × 12.75 + 2 × 25.5 = 899.5px, inside the table's 900px; without it
// 622 + 5 × 12.75 + 51 = 736.75px, inside its 760px.
const COLS = 'grid-cols-[minmax(146px,1.5fr)_minmax(130px,1fr)_72px_56px_92px_minmax(126px,1.2fr)]';
const COLS_ACT = 'grid-cols-[minmax(146px,1.5fr)_minmax(130px,1fr)_72px_56px_92px_minmax(126px,1.2fr)_150px]';
const COL = {
  orderer: 'text-start',
  tags: 'text-start',
  apartment: 'text-center',
  quantity: 'text-center',
  date: 'text-center',
  status: 'text-start',
  action: 'text-start',
} as const;
type Col = keyof typeof COL;

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

const DATE = new Intl.DateTimeFormat('he-IL', { timeZone: 'Asia/Jerusalem', day: '2-digit', month: '2-digit', year: '2-digit' });

type StatusStep = 'ready' | 'collected';

/** A header cell: the column's name, in the column's alignment. */
function Head({ col, className, children }: { col: Col; className?: string; children: string }) {
  return <span data-col={col} className={cn(HEAD_CELL, COL[col], className)}>{children}</span>;
}

/** The orderer's name. Where rows open the issue window it is a real button —
 *  the row's handle for the keyboard and for assistive technology. */
function OrdererName({ name, onOpen, className }: { name: string; onOpen?: () => void; className: string }) {
  if (!onOpen) return <span className={className}>{name}</span>;
  return (
    <button
      type="button"
      onClick={(e) => { e.stopPropagation(); onOpen(); }}
      className={cn(className, 'max-w-full cursor-pointer self-start rounded-[4px] text-start focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--chip-brand)]')}
    >
      {name}
    </button>
  );
}

/** The orderer's column: the name, and under it the role and the phone. */
function Orderer({ row, onOpen, nameClass }: { row: ChipOrderRow; onOpen?: () => void; nameClass: string }) {
  return (
    <>
      <OrdererName name={row.full_name} onOpen={onOpen} className={cn('truncate font-bold text-[var(--chip-ink)]', nameClass)} />
      <span className="truncate text-[12.5px] font-semibold text-[var(--chip-ink-muted)]">
        {CHIP_ORDER_ROLE_LABEL[row.role]} · <span className="chip-num">{e164ToLocal(row.phone_e164)}</span>
      </span>
    </>
  );
}

/** What the action column of one row holds. */
function RowAction({
  action, wide, onAsk,
}: {
  action: ChipOrderRowAction;
  /** A phone card: a button fills the card's width and is 44px tall. */
  wide: boolean;
  onAsk: (step: StatusStep) => void;
}) {
  // Chips are still missing: nothing to press. A label, not a button — and it
  // does not hold the click, so the row under it opens the issue window, which
  // is where the missing chips are issued.
  if (action.kind === 'waiting') {
    return (
      <span className="inline-flex flex-col items-start gap-1" data-testid="chip-order-row-waiting">
        <span className="inline-flex h-[24px] items-center gap-1 whitespace-nowrap rounded-[7px] border border-[var(--chip-border-strong)] bg-[var(--chip-hover)] px-2.5 text-[12px] font-bold text-[var(--chip-ink-muted)]">
          <Hourglass className="h-3.5 w-3.5" />
          {CHIP_ORDER_WAITING_LABEL}
        </span>
        <span data-testid="chip-order-row-reason" className="text-[11.5px] font-semibold leading-[1.35] text-[var(--chip-ink-muted)]">
          {action.missing}
        </span>
      </span>
    );
  }
  const ready = action.kind === 'ready';
  return (
    // The click and the keys stop here: the row behind the button opens the
    // issue window, and the button must not.
    <span
      className={cn('inline-flex', wide && 'w-full')}
      onClick={(e) => e.stopPropagation()}
      onKeyDown={(e) => e.stopPropagation()}
    >
      <button
        type="button"
        onClick={() => onAsk(action.kind)}
        data-testid={ready ? 'chip-order-row-ready' : 'chip-order-row-collected'}
        className={cn(
          'relative inline-flex cursor-pointer items-center justify-center gap-1.5 whitespace-nowrap rounded-[9px] px-3 text-[13px] font-bold text-white transition-colors',
          // 36px in the table, with a 44px hit area around it; 44px on a card.
          wide ? 'h-11 w-full' : "h-9 after:absolute after:inset-x-0 after:-inset-y-1 after:content-['']",
          ready ? 'bg-[var(--chip-brand)] hover:bg-[var(--chip-brand-hover)]' : 'bg-[var(--chip-green)] hover:bg-[var(--chip-green-ink)]',
        )}
      >
        {ready ? <Check className="h-4 w-4" strokeWidth={2.4} /> : <CheckCheck className="h-4 w-4" strokeWidth={2.2} />}
        {ready ? 'מוכן לאיסוף' : 'נאסף'}
      </button>
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
  /** chips_orders_manage:edit — the action column of a row, and
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

  // Mouse only — see the note at the top of the file (the name is the button).
  const rowProps = (o: ChipOrderRow) => (onOpen ? { onClick: () => onOpen(o) } : {});

  const actionOf = (o: ChipOrderRow) => (canEdit ? chipOrderRowAction(o, summaries.get(o.order_id)) : null);
  const askFor = (o: ChipOrderRow) => (step: StatusStep) => { setAsk({ step, row: o }); setAskOpen(true); };
  const cols = canEdit ? COLS_ACT : COLS;
  const askApartments = ask ? summaries.get(ask.row.order_id)?.apartments ?? [] : [];

  return (
    // mb-16 with the action column: the card is the LAST thing on the page, and
    // its buttons sit at the far edge — the corner of the assistant's floating
    // button (AgentFab, fixed bottom-6 left-6, 56px). Scrolled to the end, the
    // last row rises above it (the same room the paging control of other
    // screens leaves under itself).
    <div className={cn('overflow-hidden rounded-[16px] border border-[var(--chip-border)] bg-[var(--chip-panel)]', canEdit && 'mb-16')}>
      {/* Toolbar: the test-orders controls (only while there are any) · search · print · Excel · PDF */}
      <ChipsToolbar
        searchWidth="@min-[1140px]:w-[280px]"
        search={
          <Input
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="חפש לפי דירה או שם"
            aria-label="חיפוש בהזמנות לפי מספר דירה או שם"
            data-testid="chip-orders-search"
            className={CHIPS_SEARCH_INPUT}
          />
        }
        exports={
          <ChipListExports
            list={CHIP_ORDERS_EXPORT}
            rows={visible}
            rowKey={(o) => o.item_id}
            filter={searching ? [`סינון: „${query.trim()}”`] : []}
            disabled={loading}
            testId="chip-orders"
          />
        }
      >
        {testCount > 0 && (
          <>
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
          </>
        )}
      </ChipsToolbar>

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
              <div data-testid="chip-orders-head" className={cn('grid items-center gap-3 border-b border-[var(--chip-border)] bg-[var(--chip-panel-alt)] px-6 py-[13px]', cols)}>
                <Head col="orderer">מזמין</Head>
                <Head col="tags">תגיות</Head>
                <Head col="apartment">דירה</Head>
                <Head col="quantity">כמות</Head>
                <Head col="date">תאריך הזמנה</Head>
                <Head col="status">סטטוס</Head>
                {canEdit && <Head col="action" className={cn(ACT_CELL, '-my-[13px] bg-[var(--chip-panel-alt)] py-[13px]')}>פעולה</Head>}
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
                    <span data-col="orderer" className={cn(COL.orderer, 'flex min-w-0 flex-col gap-[2px]')}>
                      <Orderer row={o} onOpen={onOpen && (() => onOpen(o))} nameClass="text-[14.5px]" />
                      {hits.length > 0 && (
                        <span className="truncate text-[12px] font-semibold text-[var(--chip-brand-ink)]" data-testid="chip-order-row-hit">
                          בעל צ׳יפ בהזמנה: {hits.join(', ')}
                        </span>
                      )}
                    </span>
                    <span data-col="tags" className={cn(COL.tags, 'flex min-w-0 flex-wrap items-center gap-1.5')}>
                      <ChipOrderTags tags={chipOrderRowTags(o)} />
                    </span>
                    <span data-col="apartment" className={cn(COL.apartment, 'min-w-0 text-[14px] font-bold text-[var(--chip-ink)] [overflow-wrap:anywhere]')}>
                      <span className="chip-num">{o.apartment_number}</span>
                    </span>
                    <span data-col="quantity" className={cn(COL.quantity, 'text-[14px] font-bold text-[var(--chip-ink-muted)]')}>
                      <span className="chip-num">{o.chips_count}</span>
                    </span>
                    <span data-col="date" className={cn(COL.date, 'text-[13px] font-semibold text-[var(--chip-ink-muted)]')}>
                      <span className="chip-num">{DATE.format(new Date(o.created_at))}</span>
                    </span>
                    <span data-col="status" className={cn(COL.status, 'min-w-0')}>
                      <ChipOrderStagePill
                        stage={chipOrderStage(o.status, o.chips_linked, o.chips_count)}
                        linked={o.chips_linked}
                        ordered={o.chips_count}
                        overdue={isChipOrderOverdue(o)}
                      />
                    </span>
                    {canEdit && (
                      <span
                        data-col="action"
                        className={cn(COL.action, ACT_CELL, '-my-[12px] bg-[var(--chip-panel)] py-[12px] transition-colors', onOpen && 'group-hover:bg-[var(--chip-hover)]')}
                      >
                        {action && <RowAction action={action} wide={false} onAsk={askFor(o)} />}
                      </span>
                    )}
                  </div>
                );
              })}
            </div>
          </div>

          {/* Phone cards — the same facts, top to bottom: who, the tags, what was ordered, where it stands, the next step. */}
          <div className="space-y-2 p-4 sm:hidden">
            {visible.map((o) => {
              const action = actionOf(o);
              const hits = searching ? searchHitPeople(o, query) : [];
              const tags = chipOrderRowTags(o);
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
                  <span className="flex min-w-0 flex-col gap-[2px]">
                    <Orderer row={o} onOpen={onOpen && (() => onOpen(o))} nameClass="text-[15px]" />
                  </span>
                  {tags.length > 0 && (
                    <span className="flex flex-wrap items-center gap-1.5" data-testid="chip-order-card-tags">
                      <ChipOrderTags tags={tags} />
                    </span>
                  )}
                  <span className="text-[12.5px] font-semibold text-[var(--chip-ink-muted)]">
                    דירה <span className="chip-num">{o.apartment_number}</span> · {o.chips_count} צ׳יפים · {DATE.format(new Date(o.created_at))}
                  </span>
                  {hits.length > 0 && (
                    <span className="text-[12px] font-semibold text-[var(--chip-brand-ink)]">בעל צ׳יפ בהזמנה: {hits.join(', ')}</span>
                  )}
                  <span>
                    <ChipOrderStagePill
                      stage={chipOrderStage(o.status, o.chips_linked, o.chips_count)}
                      linked={o.chips_linked}
                      ordered={o.chips_count}
                      overdue={isChipOrderOverdue(o)}
                    />
                  </span>
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
    </div>
  );
}
