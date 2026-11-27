'use client';

// /chips → "הזמנות": the OPEN chip orders residents placed on /chip-order —
// and, after them, the orders made at the reception (25/11/2026: tagged
// "קבלה", collected the moment they are made, nothing left to do on them) —
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
// 26/11/2026 (card payments, Morning documents):
//   · "מס׳ הזמנה" is the first column, and the search finds an order by the
//     start of its number;
//   · "תשלום" — how the order was paid, one short word (chipOrderRowPayment);
//   · "חשבונית" — the invoice number as a link (a new tab; the row does not
//     open), or where the document stands ("בהפקה", "ממתינה לחיבור מורנינג",
//     "לא הופקה" in red);
//   · a WEB order that was refunded stays in the tab — readable, nothing to
//     press.

import { useMemo, useState } from 'react';
import { toast } from 'sonner';
import { AlertTriangle, Ban, Check, CheckCheck, ExternalLink, FlaskConical, Hourglass, Inbox, Loader2, Search } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  AlertDialog, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter,
  AlertDialogHeader, AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { cn } from '@/lib/utils';
import {
  CHIP_ORDER_PERSON_ROLE_LABEL, chipOrderStage, isChipOrderOverdue, type ChipOrderRow,
} from '@/lib/chipOrders/model';
import {
  CHIP_ORDERS_EXPORT, CHIP_ORDER_PAYMENT_LABEL, CHIP_ORDER_WAITING_LABEL, chipOrderCollectors, chipOrderRowAction,
  chipOrderRowDocument, chipOrderRowPayment, chipOrderRowPhone, chipOrderRowTags, filterChipOrderRows, searchHitPeople,
  summarizeChipOrders, type ChipOrderDocState, type ChipOrderRowAction,
} from '@/lib/chipOrders/orderRows';
import { CHIP_ORDER_CANCELLED_LABEL } from '@/lib/chipOrders/model';
import { RECEPTION_CANCEL_LABEL, receptionCancelStoppedText } from '@/lib/chipOrders/receptionCancelText';
import { CollectorPicker } from './CollectorPicker';
import { ReceptionCancelDialog } from './ReceptionCancelDialog';
import { ChipListExports } from './ChipListExports';
import { CHIPS_SEARCH_INPUT, ChipsToolbar } from './ChipsToolbar';
import { ChipOrderStagePill } from './ChipOrderStatusPill';
import { ChipOrderTags } from './ChipOrderTags';

// מס׳ הזמנה · מזמין · תגיות · דירה · כמות · תאריך הזמנה · תשלום · חשבונית · סטטוס
// (· פעולה — with chips_orders_manage:edit)
//
// A VALUE SITS UNDER ITS HEADER (25/11/2026). The header row and every body
// row are grids of their own, so they agree on the columns only if no track
// is sized by what it holds. Every track here is a fixed width, or a share of
// the row with a floor of its own — minmax(px, fr), never a bare `fr`, whose
// floor is its content: one long name or a wide button would then push the
// columns of that row alone. And a column has ONE alignment, written once in
// COL and worn by its header cell and by its body cells alike: text columns
// from the start edge, the four number columns centred.
// The floors, with the row's gaps and padding, must fit the table's minimum
// width — or the last column sticks out of the row. The root font is 17px, so
// gap-3 is 12.75px and px-6 is 25.5px (not 12 and 24). 26/11/2026, three more
// tracks — the order number 64px ("מס׳ הזמנה" is 50px wide in its 12px bold,
// a five-digit number 35px), the payment 88px (its longest word, "בדיקה, ללא
// חיוב", is 81px) and the invoice 96px ("ממתינה לחיבור מורנינג" breaks into
// two lines): with the action column 1020 + 9 × 12.75 + 2 × 25.5 = 1185.75px,
// inside the table's 1186px; without it 870 + 8 × 12.75 + 51 = 1023px, inside
// its 1024px. (The sticky action column keeps the next step in sight where the
// card is narrower.)
const COLS = 'grid-cols-[64px_minmax(146px,1.5fr)_minmax(130px,1fr)_72px_56px_92px_minmax(88px,0.8fr)_minmax(96px,0.8fr)_minmax(126px,1.2fr)]';
const COLS_ACT = 'grid-cols-[64px_minmax(146px,1.5fr)_minmax(130px,1fr)_72px_56px_92px_minmax(88px,0.8fr)_minmax(96px,0.8fr)_minmax(126px,1.2fr)_150px]';
const COL = {
  number: 'text-center',
  orderer: 'text-start',
  tags: 'text-start',
  apartment: 'text-center',
  quantity: 'text-center',
  date: 'text-center',
  payment: 'text-start',
  invoice: 'text-start',
  status: 'text-start',
  action: 'text-start',
} as const;
type Col = keyof typeof COL;

const HEAD_CELL = 'text-[12px] font-bold uppercase tracking-[0.02em] text-[var(--chip-ink-soft)]';
// The action column stays in sight: where the card is narrower than the table
// (most windows with the menu panel open, since 26/11/2026) the table scrolls
// sideways inside the card, and this cell holds on to the card's far edge
// instead of leaving with the rest. Its box reaches through the row's own
// padding (-me-6 / pe-6), so nothing shows between it and the edge. Only
// while the card really is narrower than the table (1186px) the cell carries
// a hairline and a soft shadow on its start side — what scrolls under it
// reads as under.
const ACT_CELL =
  'sticky end-0 z-[1] -me-6 self-stretch pe-6 ps-3 flex items-center @max-[1185px]:border-s @max-[1185px]:border-[var(--chip-border)] @max-[1185px]:shadow-[10px_0_14px_-12px_rgba(20,27,52,0.28)]';

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
  // A reception order may have no phone (nothing there is required).
  const phone = chipOrderRowPhone(row);
  return (
    <>
      <OrdererName name={row.full_name} onOpen={onOpen} className={cn('truncate font-bold text-[var(--chip-ink)]', nameClass)} />
      <span className="truncate text-[12.5px] font-semibold text-[var(--chip-ink-muted)]">
        {CHIP_ORDER_PERSON_ROLE_LABEL[row.role] ?? row.role}
        {phone && <> · <span className="chip-num">{phone}</span></>}
      </span>
    </>
  );
}

/** How the order was paid — one short word; a refund reads in red. */
function PaymentLabel({ row }: { row: ChipOrderRow }) {
  const kind = chipOrderRowPayment(row);
  if (!kind) return <span className="text-[var(--chip-ink-soft)]" data-testid="chip-order-row-payment">—</span>;
  const refund = kind === 'refunded' || kind === 'partial';
  return (
    <span
      data-testid="chip-order-row-payment"
      className={cn('text-[13px]', refund ? 'font-bold text-[var(--chip-red-ink)]' : 'font-semibold text-[var(--chip-ink-muted)]')}
    >
      {CHIP_ORDER_PAYMENT_LABEL[kind]}
    </span>
  );
}

/** Where the order's invoice stands: its number as a link (a new tab — the
 *  row under it must not open), or the state in words. The link's hit area
 *  reaches 44px around the number. */
function InvoiceState({ state }: { state: ChipOrderDocState }) {
  if (state.kind === 'issued') {
    const label = state.number ?? 'הופקה';
    if (!state.url) return <span className="chip-num text-[13px] font-bold text-[var(--chip-ink)]" data-testid="chip-order-row-invoice">{label}</span>;
    return (
      <a
        href={state.url}
        target="_blank"
        rel="noopener noreferrer"
        onClick={(e) => e.stopPropagation()}
        title="פתיחת החשבונית בלשונית חדשה"
        data-testid="chip-order-invoice-link"
        className="relative inline-flex items-center gap-1 rounded-[4px] text-[13px] font-bold text-[var(--chip-brand-ink)] hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--chip-brand)] after:absolute after:-inset-x-2 after:-inset-y-[13px] after:content-['']"
      >
        <span className="chip-num">{label}</span>
        <ExternalLink className="h-3.5 w-3.5 shrink-0" aria-hidden />
      </a>
    );
  }
  if (state.kind === 'none') return <span className="text-[var(--chip-ink-soft)]" data-testid="chip-order-row-invoice">—</span>;
  return (
    <span
      data-testid="chip-order-row-invoice"
      className={cn(
        'text-[12.5px] leading-[1.35]',
        state.kind === 'failed' ? 'font-bold text-[var(--chip-red-ink)]' : 'font-semibold text-[var(--chip-ink-muted)]',
      )}
    >
      {state.text}
    </span>
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
  // The order is collected already — a reception order, paid and handed over in
  // one go: nothing to press. A label like "בהמתנה", not a button; the row
  // under it still opens the window.
  if (action.kind === 'done') {
    return (
      <span
        className="inline-flex h-[24px] items-center gap-1 whitespace-nowrap rounded-[7px] border border-[var(--chip-border)] bg-[var(--chip-hover)] px-2.5 text-[12px] font-bold text-[var(--chip-ink-muted)]"
        data-testid="chip-order-row-done"
      >
        <CheckCheck className="h-3.5 w-3.5" />
        נאסף
      </span>
    );
  }
  // A reception order that was cancelled ("בטל הזמנת קבלה"): it stays in the
  // tab with its status. A label; the row under it still opens the window.
  if (action.kind === 'cancelled') {
    return (
      <span
        className="inline-flex h-[24px] items-center gap-1 whitespace-nowrap rounded-[7px] border border-[var(--chip-red-border)] bg-[var(--chip-red-soft)] px-2.5 text-[12px] font-bold text-[var(--chip-red-ink)]"
        data-testid="chip-order-row-cancelled"
      >
        <Ban className="h-3.5 w-3.5" />
        {CHIP_ORDER_CANCELLED_LABEL}
      </span>
    );
  }
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

/** A row "ביטול וזיכוי" is offered on (27/11/2026): a paid reception order —
 *  collected, or paid by card with its chips never saved — and a web order the
 *  card paid that waits for it: PayPlus showed it cancelled or refunded, or a
 *  run of it stopped. (Any other web order offers it in its window.) */
function rowCancellable(o: ChipOrderRow): boolean {
  if (o.source === 'reception') {
    return o.status === 'collected' || (o.status === 'paid' && o.payment_method === 'card' && o.card_status === 'paid');
  }
  return o.card_status === 'paid' && !o.cancel_completed && (!!o.payplus_reversal_kind || !!o.cancel_failed_step);
}

/** "ביטול וזיכוי" in a row's action column / on a phone card (admin and super
 *  admin). The click stops here: the row behind it opens the issue window. */
function RowCancel({ row, wide, onOpen }: { row: ChipOrderRow; wide: boolean; onOpen: () => void }) {
  const stopped = row.cancel_failed_step ?? null;
  return (
    <span
      className={cn('inline-flex flex-col items-start gap-1', wide && 'w-full')}
      onClick={(e) => e.stopPropagation()}
      onKeyDown={(e) => e.stopPropagation()}
    >
      <button
        type="button"
        onClick={onOpen}
        data-testid="chip-order-row-cancel"
        className={cn(
          'relative inline-flex cursor-pointer items-center justify-center gap-1.5 whitespace-nowrap rounded-[9px] border border-[var(--chip-red-border)] bg-white px-3 text-[13px] font-bold text-[var(--chip-red-ink)] transition-colors hover:bg-[var(--chip-red-soft)]',
          wide ? 'h-11 w-full' : "h-9 after:absolute after:inset-x-0 after:-inset-y-1 after:content-['']",
        )}
      >
        <Ban className="h-4 w-4" />
        {stopped ? 'המשך ביטול' : RECEPTION_CANCEL_LABEL}
      </button>
      {stopped && (
        <span data-testid="chip-order-row-cancel-stopped" className="text-[11.5px] font-semibold leading-[1.35] text-[var(--chip-red-ink)]">
          {receptionCancelStoppedText(stopped)}
        </span>
      )}
    </span>
  );
}

export function ChipOrdersPanel({
  items, loading, onOpen, canEdit = false, canAdmin = false, unfinishedTests = 0, onChanged, documentsConnected = false,
}: {
  items: ChipOrderRow[];
  loading: boolean;
  /** Admin / super admin, by role — "ביטול וזיכוי" (the route asks the role
   *  again). */
  canAdmin?: boolean;
  /** Morning has a key: a queued invoice is "בהפקה"; without one it is
   *  "ממתינה לחיבור מורנינג" (GET /api/chip-orders). */
  documentsConnected?: boolean;
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
  // "נאסף": who collected — one of the people of the order. Optional here.
  const [collector, setCollector] = useState<string | null>(null);
  // "ביטול וזיכוי": the order its confirmation is open for.
  const [cancelOf, setCancelOf] = useState<string | null>(null);
  const cancelFor = (o: ChipOrderRow) => (canAdmin && rowCancellable(o) ? () => setCancelOf(o.order_id) : null);

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
      const named = ask.step === 'collected' && collector !== null;
      const res = await fetch(`/api/chip-orders/${ask.row.order_id}/${ask.step}`, {
        method: 'POST',
        credentials: 'include',
        headers: named ? { 'Content-Type': 'application/json' } : undefined,
        body: named ? JSON.stringify({ person: collector }) : undefined,
      });
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
  const askFor = (o: ChipOrderRow) => (step: StatusStep) => { setAsk({ step, row: o }); setCollector(null); setAskOpen(true); };
  const cols = canEdit ? COLS_ACT : COLS;
  const askApartments = ask ? summaries.get(ask.row.order_id)?.apartments ?? [] : [];
  // The people of the WHOLE order (all its apartment rows) — who may have collected it.
  const askCollectors = ask?.step === 'collected' ? chipOrderCollectors(items, ask.row.order_id) : [];

  return (
    // mb-16 with the action column: the card is the LAST thing on the page, and
    // its buttons sit at the far edge — the corner of the assistant's floating
    // button (AgentFab, fixed bottom-6 left-6, 56px). Scrolled to the end, the
    // last row rises above it (the same room the paging control of other
    // screens leaves under itself).
    <div className={cn('overflow-hidden rounded-[16px] border border-[var(--chip-border)] bg-[var(--chip-panel)]', canEdit && 'mb-16')}>
      {cancelOf && (
        <ReceptionCancelDialog
          orderId={cancelOf}
          open
          onOpenChange={(v) => { if (!v) setCancelOf(null); }}
          onChanged={() => void onChanged?.()}
        />
      )}
      {/* Toolbar: the test-orders controls (only while there are any) · search · print · Excel · PDF */}
      <ChipsToolbar
        searchWidth="@min-[1140px]:w-[280px]"
        search={
          <Input
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            // "חפש לפי מספר הזמנה, דירה או שם" does not fit the box — 280px on
            // a desktop, and a phone's 16px field at 320px — so the words of
            // the fields alone; the label says it in full.
            placeholder="מס׳ הזמנה, דירה או שם"
            aria-label="חיפוש בהזמנות לפי מספר הזמנה, מספר דירה או שם"
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
          <p className="text-[13px] font-medium text-[var(--chip-ink-soft)]">הזמנה מהאתר מופיעה כאן אחרי שהתשלום אושר, ויוצאת כשהיא נאספת או נדחית. הזמנה שנרשמה בקבלה, והזמנה שזוכתה, נשארות ברשימה.</p>
        </div>
      ) : visible.length === 0 ? (
        // Search-empty is not table-empty (as in the chips tab).
        <div className="flex flex-col items-center gap-3 p-12 text-center" data-testid="chip-orders-no-match">
          <span className="grid h-12 w-12 place-items-center rounded-full bg-[var(--chip-hover)] text-[var(--chip-ink-soft)]">
            <Search className="h-5 w-5" />
          </span>
          <p className="text-[15px] font-bold text-[var(--chip-ink)]">אין הזמנות עבור „{query.trim()}”</p>
          <p className="text-[13px] font-medium text-[var(--chip-ink-soft)]">החיפוש מכסה מספר הזמנה (מתחילתו), מספר דירה, שם המזמין ושמות בעלי הצ׳יפ שבהזמנה.</p>
        </div>
      ) : (
        <>
          {/* Desktop table */}
          <div className="@container hidden overflow-x-auto sm:block">
            <div className={canEdit ? 'min-w-[1186px]' : 'min-w-[1024px]'} data-testid="chip-orders-table">
              <div data-testid="chip-orders-head" className={cn('grid items-center gap-3 border-b border-[var(--chip-border)] bg-[var(--chip-panel-alt)] px-6 py-[13px]', cols)}>
                <Head col="number">מס׳ הזמנה</Head>
                <Head col="orderer">מזמין</Head>
                <Head col="tags">תגיות</Head>
                <Head col="apartment">דירה</Head>
                <Head col="quantity">כמות</Head>
                <Head col="date">תאריך הזמנה</Head>
                <Head col="payment">תשלום</Head>
                <Head col="invoice">חשבונית</Head>
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
                    <span data-col="number" className={cn(COL.number, 'text-[14px] font-bold text-[var(--chip-ink-muted)]')}>
                      <span className="chip-num">{o.order_number}</span>
                    </span>
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
                    <span data-col="payment" className={cn(COL.payment, 'min-w-0')}>
                      <PaymentLabel row={o} />
                    </span>
                    <span data-col="invoice" className={cn(COL.invoice, 'min-w-0')}>
                      <InvoiceState state={chipOrderRowDocument(o, documentsConnected)} />
                    </span>
                    <span data-col="status" className={cn(COL.status, 'min-w-0')}>
                      <ChipOrderStagePill
                        stage={chipOrderStage(o.status, o.chips_linked, o.chips_count, o.source)}
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
                        {/* A collected order: "ביטול וזיכוי" in place of the "נאסף" label (the status column says it). */}
                        {(() => {
                          const cancel = cancelFor(o);
                          if (cancel && action?.kind === 'done') return <RowCancel row={o} wide={false} onOpen={cancel} />;
                          return (
                            <>
                              {action && <RowAction action={action} wide={false} onAsk={askFor(o)} />}
                              {cancel && <RowCancel row={o} wide={false} onOpen={cancel} />}
                            </>
                          );
                        })()}
                      </span>
                    )}
                  </div>
                );
              })}
            </div>
          </div>

          {/* Phone cards — the same facts, top to bottom: who, the tags, what was ordered, how it was paid, where it stands, the next step. */}
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
                  <span className="text-[12.5px] font-semibold text-[var(--chip-ink-muted)] [overflow-wrap:anywhere]">
                    הזמנה <span className="chip-num">{o.order_number}</span> · דירה <span className="chip-num">{o.apartment_number}</span> · {o.chips_count} צ׳יפים · {DATE.format(new Date(o.created_at))}
                  </span>
                  {hits.length > 0 && (
                    <span className="text-[12px] font-semibold text-[var(--chip-brand-ink)]">בעל צ׳יפ בהזמנה: {hits.join(', ')}</span>
                  )}
                  <span className="flex flex-wrap items-center gap-x-4 gap-y-1 text-[12.5px] font-semibold text-[var(--chip-ink-muted)]" data-testid="chip-order-card-money">
                    <span>תשלום: <PaymentLabel row={o} /></span>
                    <span>חשבונית: <InvoiceState state={chipOrderRowDocument(o, documentsConnected)} /></span>
                  </span>
                  <span>
                    <ChipOrderStagePill
                      stage={chipOrderStage(o.status, o.chips_linked, o.chips_count, o.source)}
                      linked={o.chips_linked}
                      ordered={o.chips_count}
                      overdue={isChipOrderOverdue(o)}
                    />
                  </span>
                  {(() => {
                    const cancel = cancelFor(o);
                    if (cancel && action?.kind === 'done') return <RowCancel row={o} wide onOpen={cancel} />;
                    return (
                      <>
                        {action && <RowAction action={action} wide onAsk={askFor(o)} />}
                        {cancel && <RowCancel row={o} wide onOpen={cancel} />}
                      </>
                    );
                  })()}
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
          {askCollectors.length > 0 && (
            <div className="flex flex-col gap-2" data-testid="chip-order-row-collector">
              <span className="text-[13px] font-bold text-[var(--chip-ink)]">מי אסף את הצ׳יפים? <span className="font-semibold text-[var(--chip-ink-muted)]">(לא חובה)</span></span>
              <CollectorPicker
                people={askCollectors}
                value={collector}
                onChange={setCollector}
                disabled={acting}
                optional
                showApartment={askApartments.length > 1}
                testId="chip-order-row-collector-option"
              />
            </div>
          )}
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
