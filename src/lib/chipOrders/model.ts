import type { ChipResidentRole, ChipStatus, ChipType } from '@/lib/types/chips';

// Chip orders (/chip-order, 12/11/2026) — the pure, client-safe half: types,
// statuses and their Hebrew labels, the price rule and the due date. The
// server and the public page import the SAME functions, so the price a
// resident sees is the price the server charges (the server recomputes it and
// never trusts a total from the browser).

export type ChipOrderRole = 'owner' | 'tenant' | 'operator';

/** paid = being assigned (13/11/2026: the approval step is gone — a paid
 *  order goes straight to assigning chips). 'approved' is LEGACY only: rows
 *  approved before 13/11 were mapped to paid (migration 20261113220605), and
 *  nothing writes it any more; the code still treats it as paid, so a rollback
 *  build that approves an order leaves nothing stranded. */
export type ChipOrderStatus =
  | 'pending_payment'
  | 'paid'
  | 'approved'
  | 'ready'
  | 'collected'
  | 'rejected';

/** Open = still in the Orders tab: paid (assigning) or ready. A row leaves the
 *  tab once collected or rejected. */
const OPEN_CHIP_ORDER_STATUSES: readonly ChipOrderStatus[] = ['paid', 'approved', 'ready'];

export function isOpenChipOrder(status: ChipOrderStatus): boolean {
  return OPEN_CHIP_ORDER_STATUSES.includes(status);
}

/** owner phone = registry owner → matched; another owner on file → review;
 *  no owner on file → unassigned; tenant / operator → document_review. */
export type ChipOrderMatchStatus = 'matched' | 'review' | 'unassigned' | 'document_review';

/** not_required — a rejected TEST order: nothing was charged, Grow is never asked. */
export type ChipOrderRefundStatus = 'refunded' | 'manual_required' | 'not_required';

/** The three messages an orderer gets (the "approved" message went with the
 *  approval step, 13/11/2026; old rows of that kind stay in the history). */
export type ChipOrderNotifyKind = 'paid' | 'ready' | 'rejected';

export const CHIP_ORDER_ROLES: readonly ChipOrderRole[] = ['owner', 'tenant', 'operator'];

export const CHIP_ORDER_ROLE_LABEL: Record<ChipOrderRole, string> = {
  owner: 'בעלים',
  tenant: 'שוכר',
  operator: 'מפעיל',
};

export const CHIP_ORDER_STATUS_LABEL: Record<ChipOrderStatus, string> = {
  pending_payment: 'ממתין לתשלום',
  paid: 'שולם, בהכנה',
  approved: 'שולם, בהכנה',
  ready: 'מוכן לאיסוף',
  collected: 'נאסף',
  rejected: 'נדחה',
};

export const CHIP_ORDER_MATCH_LABEL: Record<ChipOrderMatchStatus, string> = {
  matched: 'תואם',
  review: 'לבדיקה',
  unassigned: 'לשיוך',
  document_review: 'מסמך לבדיקה',
};

export const CHIP_ORDER_REFUND_LABEL: Record<ChipOrderRefundStatus, string> = {
  refunded: 'זוכה במלואו',
  manual_required: 'דורש זיכוי ידני',
  not_required: 'לא נדרש (בדיקה)',
};

/** The label of a test order — the badge in /chips and the prefix of every
 *  message it sends. */
export const CHIP_ORDER_TEST_LABEL = 'בדיקה';

/** A test order whose phone code was skipped ("דלג על אימות (מצב בדיקה)",
 *  13/11/2026) — the badge in /chips. */
export const CHIP_ORDER_PHONE_UNVERIFIED_LABEL = 'טלפון לא אומת';

/** Test mode: the header the order page sends its test-link token in (never
 *  a URL the server logs). Checked by every public chip-order API call. */
export const CHIP_ORDER_TEST_HEADER = 'x-chip-order-test';

/** The strip pinned to the top of /chip-order in test mode. */
export const CHIP_ORDER_TEST_BANNER = 'מצב בדיקה, אין חיוב';

/** Roles that must attach a lease / management agreement and its end date. */
export function needsLease(role: ChipOrderRole): boolean {
  return role === 'tenant' || role === 'operator';
}

// ── Settings (app_settings key 'chip_orders') ─────────────────────────────

export interface ChipOrderSettings {
  /** ₪ per chip — ONE flat price for every chip of an order (21/11/2026:
   *  no threshold, no higher price above it, no quantity limit). */
  unitPrice: number;
  /** Where and when chips are collected — goes into the "ready" message. */
  pickupText: string;
  /** Order terms shown above the consent checkbox (Grow's go-live review asks for one). */
  termsText: string;
  /** The page switch. Effective only when Grow is configured as well. */
  ordersOpen: boolean;
}

export const DEFAULT_CHIP_ORDER_SETTINGS: ChipOrderSettings = {
  unitPrice: 50,
  pickupText: '',
  termsText: '',
  ordersOpen: false,
};

export const CHIP_ORDER_LIMITS = {
  /** Chips one apartment may order in one order (Ronen, 21/11/2026 noon),
   *  counted over ALL its rows; an order may hold several apartments, each up
   *  to this. Checked on the page (plus button + submit) and on the server.
   *  The DB CHECK of chip_order_items / chip_order_holders (≤ 50) stays as
   *  the storage ceiling. The issue window has no limit. */
  maxChipsPerApartment: 10,
  /** The orderer's note ("הערות" on the public page) — stored as the order's
   *  note (chip_orders.internal_note, the "הערה" of the issue window). */
  customerNoteMax: 500,
  /** Rows (people) in one order — several may share an apartment. A bound on
   *  the public request, not on the quantity. */
  maxRowsPerOrder: 20,
  leaseFileBytes: 10 * 1024 * 1024,
  /** The whole multipart submit (every lease + the JSON) — checked from
   *  Content-Length before the body is read. */
  maxRequestBytes: 41 * 1024 * 1024,
  /** All the leases of one order together. */
  maxLeaseBytesTotal: 40 * 1024 * 1024,
  /** Chip-order codes sent per day, all phones together (an SMS costs money). */
  otpPerDay: 300,
  maxPrice: 10_000,
} as const;

/** Shown next to the quantity (plus button / submit) and returned by the server. */
export const CHIP_ORDER_APT_LIMIT_MESSAGE =
  `ניתן להזמין עד ${CHIP_ORDER_LIMITS.maxChipsPerApartment} כרטיסים לדירה בהזמנה אחת. לכמות גדולה יותר יש לפנות להנהלת הבניין.`;

/** The lease may be a PDF or a photo. */
export const LEASE_FILE_EXTS = ['pdf', 'jpg', 'jpeg', 'png', 'webp'] as const;
export const LEASE_FILE_ACCEPT = LEASE_FILE_EXTS.map((e) => `.${e}`).join(',');

// ── Price ────────────────────────────────────────────────────────────────

export interface LinePrice {
  unitPrice: number;
  threshold: number;
  priceAbove: number;
  lineTotal: number;
}

/** One apartment line at the flat price: chips × unit price. Agorot-safe
 *  (integer arithmetic on cents). The snapshot columns of the old threshold
 *  rule stay filled so an order still reads alone: threshold = the line's own
 *  count and price_above = the unit price, i.e. every chip at one price. Orders
 *  made before 21/11/2026 keep the threshold snapshot they were sold with. */
export function priceLine(chipsCount: number, s: Pick<ChipOrderSettings, 'unitPrice'>): LinePrice {
  const n = Math.max(0, Math.floor(chipsCount));
  return {
    unitPrice: s.unitPrice,
    threshold: n,
    priceAbove: s.unitPrice,
    lineTotal: (n * Math.round(s.unitPrice * 100)) / 100,
  };
}

export function orderTotal(lines: { lineTotal: number }[]): number {
  return Math.round(lines.reduce((s, l) => s + Math.round(l.lineTotal * 100), 0)) / 100;
}

/** The order page's money format (20/11/2026 design): "240₪", "1,050₪",
 *  "52.5₪" — the number first, then the sign, rendered inside an LTR-isolated
 *  span. */
export function formatIlsAfter(n: number): string {
  return `${n.toLocaleString('en-US', { maximumFractionDigits: 2 })}₪`;
}

/** ₪ with up to two decimals, no trailing zeros ("₪50", "₪52.5"). */
export function formatIls(n: number): string {
  const v = Number.isInteger(n) ? String(n) : n.toFixed(2).replace(/0+$/, '').replace(/\.$/, '');
  return `₪${v}`;
}

// ── Due date: 72 working hours, Sunday–Thursday (Asia/Jerusalem) ─────────

const DUE_WORKING_HOURS = 72;
const HOUR_MS = 3_600_000;

/** Weekday (0 = Sunday) and the ms since local midnight, in Israel time. */
function jerusalemParts(d: Date): { weekday: number; msIntoDay: number } {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Jerusalem',
    weekday: 'short',
    hour: 'numeric',
    minute: 'numeric',
    second: 'numeric',
    hourCycle: 'h23',
  });
  const parts = Object.fromEntries(fmt.formatToParts(d).map((p) => [p.type, p.value]));
  const weekday = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(parts.weekday);
  const msIntoDay =
    (Number(parts.hour) * 3600 + Number(parts.minute) * 60 + Number(parts.second)) * 1000 + d.getUTCMilliseconds();
  return { weekday, msIntoDay };
}

/**
 * paid_at + 72 hours that fall on Sunday–Thursday (Israel time). Friday and
 * Saturday do not count at all; every hour of a working day does (the rule is
 * "72 שעות עבודה, א' עד ה'", not office hours). Holidays are not modelled.
 * A payment on a Friday starts counting on Sunday 00:00. (Until 13/11/2026 the
 * clock started at the approval; there is no approval any more.)
 */
export function chipOrderDueAt(paidAt: Date): Date {
  let cursor = paidAt.getTime();
  let remaining = DUE_WORKING_HOURS * HOUR_MS;
  // At most a few weeks of iterations — each loop either consumes a working
  // day's remainder or skips one weekend day.
  for (let guard = 0; guard < 60 && remaining > 0; guard++) {
    const { weekday, msIntoDay } = jerusalemParts(new Date(cursor));
    const leftToday = 24 * HOUR_MS - msIntoDay;
    if (weekday === 5 || weekday === 6) {
      cursor += leftToday; // skip to the next local midnight
      continue;
    }
    const take = Math.min(remaining, leftToday);
    cursor += take;
    remaining -= take;
  }
  return new Date(cursor);
}

/** Overdue = still being assigned (not ready yet) after its due date. */
export function isChipOrderOverdue(
  o: { status: ChipOrderStatus; due_at: string | null },
  now: Date = new Date(),
): boolean {
  return (o.status === 'paid' || o.status === 'approved') && o.due_at !== null && new Date(o.due_at).getTime() < now.getTime();
}

// ── The stage of ONE apartment of an order (the Orders tab row, the order
//    section in the issue window) ──────────────────────────────────────────

/** awaiting "ממתין לשיוך" · partial "שויכו X מתוך Y" · assigned "שויך" ·
 *  ready "מוכן לאיסוף" (the order's own status). X counts ACTIVE chips only. */
export type ChipOrderStage = 'awaiting' | 'partial' | 'assigned' | 'ready';

export function chipOrderStage(status: ChipOrderStatus, linked: number, ordered: number): ChipOrderStage {
  if (status === 'ready') return 'ready';
  if (linked <= 0) return 'awaiting';
  return linked >= ordered ? 'assigned' : 'partial';
}

export function chipOrderStageLabel(stage: ChipOrderStage, linked: number, ordered: number): string {
  switch (stage) {
    case 'awaiting': return 'ממתין לשיוך';
    case 'partial': return `שויכו ${linked} מתוך ${ordered}`;
    case 'assigned': return 'שויך';
    case 'ready': return 'מוכן לאיסוף';
  }
}

// ── Shapes the staff screen reads ──────────────────────────────────────────

/** One row of /chips → "הזמנות": ONE APARTMENT of an open order (13/11/2026;
 *  until then a row was a whole order). */
export interface ChipOrderRow {
  item_id: string;
  order_id: string;
  order_number: number;
  contact_id: string;
  apartment_number: string;
  full_name: string;
  phone_e164: string;
  role: ChipOrderRole;
  status: ChipOrderStatus;
  /** Chips this apartment ordered. */
  chips_count: number;
  /** ACTIVE chips issued for this apartment line (chips.order_item_id). */
  chips_linked: number;
  /** What this apartment line cost (the stored price snapshot). */
  line_total: number;
  /** The people of this apartment line — the names of its holder lines, in the
   *  order of the window's blocks; a line with no holder line of the order
   *  itself (an order made before 20/11/2026) starts with whoever ordered. */
  people: string[];
  paid_at: string | null;
  due_at: string | null;
  created_at: string;
  has_failed_notification: boolean;
  /** A test-mode order — shown with a "בדיקה" badge, never counted. */
  is_test: boolean;
  /** False = the phone code was skipped in test mode — "טלפון לא אומת". */
  phone_verified: boolean;
}

/** One "פרטי הזמנה" section of the issue window: an OPEN order of the same
 *  person (same phone) for this apartment — its line for the apartment, plus
 *  what the order-wide buttons need ("מוכן לאיסוף" acts on the whole order). */
export interface ChipOrderSection {
  order_id: string;
  order_number: number;
  item_id: string;
  full_name: string;
  phone_e164: string;
  email: string;
  address: string;
  role: ChipOrderRole;
  status: ChipOrderStatus;
  /** What the order was paid in total (every apartment of it). */
  total: number;
  chips_count: number;
  /** ACTIVE chips linked to this line. */
  chips_linked: number;
  lease_file_key: string | null;
  lease_file_name: string | null;
  lease_end_date: string | null;
  paid_at: string | null;
  due_at: string | null;
  created_at: string;
  is_test: boolean;
  phone_verified: boolean;
  /** The order's OTHER apartments (an order may cover several). */
  other_apartments: string[];
  /** Every line of the order has all its chips (active) — "מוכן לאיסוף". */
  order_all_linked: boolean;
}

/** What the issue window loads for an Orders-tab row. */
export interface ChipOrderSheetContext {
  contact_id: string;
  apartment_number: string;
  /** The clicked row's orderer — the holder block is matched / prefilled from it. */
  holder: { full_name: string; phone_e164: string; role: ChipOrderRole };
  sections: ChipOrderSection[];
}

// ── The issue window of an order (20/11/2026 design) ───────────────────────

/** A chip as the order window shows it. */
export interface ChipOrderWindowChip {
  id: string;
  chip_number: string;
  chip_type: ChipType;
  status: ChipStatus;
  contact_id: string;
  order_item_id: string | null;
  order_holder_id: string | null;
  resident_role: ChipResidentRole;
  holder_name: string | null;
  holder_phone: string | null;
}

/** One apartment line of the order (price snapshot, as stored). */
export interface ChipOrderWindowItem {
  id: string;
  contact_id: string;
  apartment_number: string;
  chips_count: number;
  unit_price: number;
  threshold: number;
  price_above: number;
  line_total: number;
  lease_file_key: string | null;
  lease_file_name: string | null;
  lease_end_date: string | null;
  /** ACTIVE chips linked to the line. */
  chips_linked: number;
}

/** One block of the window = one person.
 *   'order'  — a row of the public page (chip_order_holders, part of the paid quantity);
 *   'staff'  — a holder the staff added (chip_order_holders, chips_count 0, never priced);
 *   'legacy' — an order made before 20/11/2026 has no holder lines: one block per
 *              apartment, built from the order's own name and phone (stored as a
 *              holder line the first time the block is saved). */
export interface ChipOrderWindowHolder {
  id: string | null;
  item_id: string;
  source: 'order' | 'staff' | 'legacy';
  role: ChipResidentRole;
  full_name: string;
  phone: string | null;
  email: string | null;
  chips_count: number;
  lease_file_key: string | null;
  lease_file_name: string | null;
  lease_end_date: string | null;
  /** Chips issued for THIS person of this order. */
  chips: ChipOrderWindowChip[];
  /** The same person's earlier chips in this apartment (matched by phone) —
   *  shown in the block; not part of the order's count. */
  existing: ChipOrderWindowChip[];
}

export interface ChipOrderWindowOrder {
  id: string;
  order_number: number;
  status: ChipOrderStatus;
  role: ChipOrderRole;
  is_test: boolean;
  phone_verified: boolean;
  full_name: string;
  phone_e164: string;
  email: string;
  address: string;
  total: number;
  paid_at: string | null;
  due_at: string | null;
  created_at: string;
  internal_note: string | null;
}

/** What the issue window loads for an Orders-tab row (20/11/2026). */
export interface ChipOrderWindow {
  order: ChipOrderWindowOrder;
  items: ChipOrderWindowItem[];
  holders: ChipOrderWindowHolder[];
  /** The line whose row was clicked — a holder the staff adds goes there. */
  clicked_item_id: string;
  /** Every line has all its chips (active) — "מוכן לאיסוף" may go. */
  order_all_linked: boolean;
}
