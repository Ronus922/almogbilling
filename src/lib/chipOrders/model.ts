// Chip orders (/chip-order, 12/11/2026) — the pure, client-safe half: types,
// statuses and their Hebrew labels, the price rule and the due date. The
// server and the public page import the SAME functions, so the price a
// resident sees is the price the server charges (the server recomputes it and
// never trusts a total from the browser).

export type ChipOrderRole = 'owner' | 'tenant' | 'operator';

export type ChipOrderStatus =
  | 'pending_payment'
  | 'paid'
  | 'approved'
  | 'ready'
  | 'collected'
  | 'rejected';

/** owner phone = registry owner → matched; another owner on file → review;
 *  no owner on file → unassigned; tenant / operator → document_review. */
export type ChipOrderMatchStatus = 'matched' | 'review' | 'unassigned' | 'document_review';

/** not_required — a rejected TEST order: nothing was charged, Grow is never asked. */
export type ChipOrderRefundStatus = 'refunded' | 'manual_required' | 'not_required';

export type ChipOrderNotifyKind = 'paid' | 'approved' | 'ready' | 'rejected';

export const CHIP_ORDER_ROLES: readonly ChipOrderRole[] = ['owner', 'tenant', 'operator'];

export const CHIP_ORDER_ROLE_LABEL: Record<ChipOrderRole, string> = {
  owner: 'בעלים',
  tenant: 'שוכר',
  operator: 'מפעיל',
};

export const CHIP_ORDER_STATUS_LABEL: Record<ChipOrderStatus, string> = {
  pending_payment: 'ממתין לתשלום',
  paid: 'שולם, ממתין לבדיקה',
  approved: 'מאושר, בהכנה',
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
  /** ₪ per chip for chips 1..threshold of one apartment. */
  unitPrice: number;
  /** X — how many chips per apartment are sold at unitPrice. */
  threshold: number;
  /** ₪ per chip from chip X+1 of one apartment. */
  priceAbove: number;
  /** Most chips one apartment may order in one order. */
  maxPerApartment: number;
  /** Where and when chips are collected — goes into the "ready" message. */
  pickupText: string;
  /** Order terms shown above the consent checkbox (Grow's go-live review asks for one). */
  termsText: string;
  /** The page switch. Effective only when Grow is configured as well. */
  ordersOpen: boolean;
}

export const DEFAULT_CHIP_ORDER_SETTINGS: ChipOrderSettings = {
  unitPrice: 50,
  threshold: 2,
  priceAbove: 70,
  maxPerApartment: 4,
  pickupText: '',
  termsText: '',
  ordersOpen: false,
};

export const CHIP_ORDER_LIMITS = {
  /** Hard ceiling of the settings field (the DB CHECK allows 50). */
  maxPerApartmentCeiling: 20,
  maxApartmentsPerOrder: 10,
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

/** Chips 1..X of ONE apartment at the base price, chip X+1 onwards at the
 *  price above the threshold. Agorot-safe (integer arithmetic on cents). */
export function priceLine(
  chipsCount: number,
  s: Pick<ChipOrderSettings, 'unitPrice' | 'threshold' | 'priceAbove'>,
): LinePrice {
  const n = Math.max(0, Math.floor(chipsCount));
  const base = Math.min(n, s.threshold);
  const above = Math.max(0, n - s.threshold);
  const cents = base * Math.round(s.unitPrice * 100) + above * Math.round(s.priceAbove * 100);
  return {
    unitPrice: s.unitPrice,
    threshold: s.threshold,
    priceAbove: s.priceAbove,
    lineTotal: cents / 100,
  };
}

export function orderTotal(lines: { lineTotal: number }[]): number {
  return Math.round(lines.reduce((s, l) => s + Math.round(l.lineTotal * 100), 0)) / 100;
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
 * approved_at + 72 hours that fall on Sunday–Thursday (Israel time). Friday and
 * Saturday do not count at all; every hour of a working day does (the rule is
 * "72 שעות עבודה, א' עד ה'", not office hours). Holidays are not modelled.
 * Approval on a Friday starts counting on Sunday 00:00.
 */
export function chipOrderDueAt(approvedAt: Date): Date {
  let cursor = approvedAt.getTime();
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

/** Overdue = still being prepared after its due date. */
export function isChipOrderOverdue(
  o: { status: ChipOrderStatus; due_at: string | null },
  now: Date = new Date(),
): boolean {
  return o.status === 'approved' && o.due_at !== null && new Date(o.due_at).getTime() < now.getTime();
}

// ── Shapes the staff screen reads ──────────────────────────────────────────

export interface ChipOrderListItem {
  id: string;
  order_number: number;
  full_name: string;
  phone_e164: string;
  role: ChipOrderRole;
  status: ChipOrderStatus;
  total: number;
  paid_at: string | null;
  due_at: string | null;
  created_at: string;
  apartments: string[];
  chips_total: number;
  chips_linked: number;
  has_failed_notification: boolean;
  /** A test-mode order — shown with a "בדיקה" badge, never counted or summed. */
  is_test: boolean;
  /** False = the phone code was skipped in test mode — "טלפון לא אומת". */
  phone_verified: boolean;
}

export interface ChipOrderItemDetail {
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
  match_status: ChipOrderMatchStatus;
  /** Chips already issued for this line (chips.order_item_id). */
  linked_chips: { id: string; chip_number: string; status: string }[];
  /** The registry slot the order's role maps to, read live. */
  registry: { name: string | null; phone: string | null; email: string | null; emailSupported: boolean };
}

export interface ChipOrderNotification {
  id: string;
  kind: ChipOrderNotifyKind;
  channel: 'email' | 'whatsapp';
  status: 'sent' | 'failed' | 'skipped';
  error: string | null;
  created_at: string;
}

export interface ChipOrderDetail {
  id: string;
  order_number: number;
  full_name: string;
  phone_e164: string;
  email: string;
  address: string;
  role: ChipOrderRole;
  status: ChipOrderStatus;
  total: number;
  grow_transaction_id: string | null;
  grow_asmachta: string | null;
  invoice_url: string | null;
  invoice_number: string | null;
  paid_at: string | null;
  approved_at: string | null;
  due_at: string | null;
  ready_at: string | null;
  collected_at: string | null;
  rejected_at: string | null;
  reject_reason: string | null;
  refund_status: ChipOrderRefundStatus | null;
  refund_note: string | null;
  created_at: string;
  is_test: boolean;
  /** False = the phone code was skipped in test mode — "טלפון לא אומת". */
  phone_verified: boolean;
  items: ChipOrderItemDetail[];
  notifications: ChipOrderNotification[];
}

/** Which registry fields an approval writes, per apartment line. */
export interface ChipOrderApprovalFields {
  item_id: string;
  name: boolean;
  phone: boolean;
  email: boolean;
}

/** ACTIVE chips issued for a line — a deactivated one no longer counts as
 *  delivered, so it can be replaced. */
export function activeLinked(item: { linked_chips: { status: string }[] }): number {
  return item.linked_chips.filter((c) => c.status === 'active').length;
}

/** Every line has as many ACTIVE chips linked as it ordered. */
export function allChipsLinked(items: { chips_count: number; linked_chips: { status: string }[] }[]): boolean {
  return items.length > 0 && items.every((i) => activeLinked(i) >= i.chips_count);
}
