import 'server-only';
import { randomBytes } from 'node:crypto';
import type { PoolClient } from 'pg';
import { query, queryOne, withTransaction } from '@/lib/db';
import { toPortalE164 } from '@/lib/portal/phone';
import { coerceContactInput } from '@/lib/validation/contacts';
import { updateContact } from '@/lib/db/contacts';
import { writeAuditInTx } from '@/lib/db/audit';
import { deactivateChipInTx } from '@/lib/db/chips';
import { forgetLeaseUploads } from '@/lib/db/chipLeaseUploads';
import { enqueueDocumentInTx, getInvoiceRowOfOrderInTx } from '@/lib/db/chipOrderDocuments';
import { SESSION_LOOKUP_MINUTES } from '@/lib/db/chipOrderCard';
import { israelDate } from '@/lib/morning/documents';
import { chipOrderMatchStatus } from '@/lib/chipOrders/match';
import { PICKUP_ORDERER_KEY, isPickupPersonKey } from '@/lib/chipOrders/pickup';
import {
  chipOrderDueAt,
  isOpenChipOrder,
  orderTotal,
  priceLine,
  type ChipOrderMatchStatus,
  type ChipOrderNotifyKind,
  type ChipOrderPersonRole,
  type ChipOrderRefundStatus,
  type ChipOrderRole,
  type ChipOrderRow,
  type ChipOrderSection,
  type ChipOrderSettings,
  type ChipOrderSheetContext,
  type ChipOrderStatus,
} from '@/lib/chipOrders/model';

// Chip orders — the DB side (migration 20261112194633). The order lives in
// chip_orders / chip_order_items; the chips themselves are issued through the
// EXISTING chips module (issueChipGroups), which stamps chips.order_item_id.

export class ChipOrderStateError extends Error {
  constructor(message = 'invalid_state') {
    super(message);
    this.name = 'ChipOrderStateError';
  }
}

// ── The public page ────────────────────────────────────────────────────────

/** Apartments a resident may order for — the registry's apartments, numbers
 *  only (never a name), in natural numeric order. */
export async function listOrderableApartments(): Promise<string[]> {
  const r = await query<{ apartment_number: string }>(
    `select apartment_number from public.contacts
      where unit_type = 'apartment'
      order by nullif(regexp_replace(apartment_number, '\\D', '', 'g'), '')::numeric asc nulls last,
               apartment_number asc`,
  );
  return r.rows.map((row) => row.apartment_number);
}

export interface NewOrderLine {
  /** The apartment NUMBER the resident picked — resolved here to the registry
   *  row (unit_type 'apartment'); the public page never sees a contact id. */
  apartmentNumber: string;
  chipsCount: number;
  lease: { objectKey: string; fileName: string; mime: string; size: number } | null;
  leaseEndDate: string | null;
}

/** One row of the redesigned order page (20/11/2026) = ONE PERSON who will
 *  hold chips. Rows of the same apartment are priced together. */
export interface NewOrderRow {
  role: 'owner' | 'tenant';
  fullName: string;
  apartmentNumber: string;
  chipsCount: number;
  phoneE164: string;
  email: string | null;
  lease: { objectKey: string; fileName: string; mime: string; size: number } | null;
  leaseEndDate: string | null;
}

export interface NewOrderInput {
  fullName: string;
  phoneE164: string;
  email: string;
  address: string;
  role: ChipOrderRole;
  /** The page before 20/11/2026: one line per apartment, no holder lines.
   *  Kept for the tests and as the shape of an old order. */
  lines?: NewOrderLine[];
  /** The page from 20/11/2026: one row per person; becomes one apartment
   *  line per apartment (the price) + one holder line per row. */
  rows?: NewOrderRow[];
  /** The address in its three parts (20/11/2026); `address` is composed from it. */
  addressParts?: { street: string; city: string; zip: string } | null;
  /** The renter commitment box was ticked (only when a renter row exists). */
  renterTermsAccepted?: boolean;
  /** The orderer's "הערות" (21/11/2026) — stored as the order's note
   *  (internal_note), which the issue window shows and edits as "הערה". */
  note?: string | null;
  ip: string | null;
  /** Test mode (a valid test link): the order is marked is_test and is later
   *  paid with the sandbox card (or "סיים הזמנת בדיקה" without PayPlus). */
  isTest?: boolean;
  /** The order form has no phone code step (26/11/2026): a new order stores
   *  NULL. True / false exist only on orders made before that. */
  phoneVerified?: boolean | null;
}

export interface CreatedOrder {
  id: string;
  orderNumber: number;
  trackingToken: string;
  total: number;
  apartments: string[];
}

interface ApartmentOwners {
  contactId: string;
  apartment: string;
  phones: string[];
  onFile: boolean;
}

/** Each apartment's registry row, its owner phones on file (contacts.owner_phone
 *  + extra owners) in E.164, and whether ANY owner is on file. Keyed by the
 *  apartment number exactly as the registry holds it. */
async function ownersOf(client: PoolClient, apartmentNumbers: string[]): Promise<Map<string, ApartmentOwners>> {
  const rows = (
    await client.query<{ id: string; apartment_number: string; owner_name: string | null; owner_phone: string | null; extra: (string | null)[] | null; extra_count: number }>(
      `select c.id, c.apartment_number, c.owner_name, c.owner_phone,
              array(select p.phone from public.contact_people p where p.contact_id = c.id and p.role = 'owner') as extra,
              (select count(*)::int from public.contact_people p where p.contact_id = c.id and p.role = 'owner') as extra_count
         from public.contacts c
        where c.apartment_number = any($1::text[]) and c.unit_type = 'apartment'`,
      [apartmentNumbers],
    )
  ).rows;
  const out = new Map<string, ApartmentOwners>();
  for (const r of rows) {
    const phones = [r.owner_phone, ...(r.extra ?? [])]
      .map((p) => toPortalE164(p))
      .filter((p): p is string => p !== null);
    const onFile = Boolean(r.owner_name?.trim() || r.owner_phone?.trim() || r.extra_count > 0);
    out.set(r.apartment_number, { contactId: r.id, apartment: r.apartment_number, phones, onFile });
  }
  return out;
}

type OrderGroup = { apartmentNumber: string; chipsCount: number; rows: NewOrderRow[]; line: NewOrderLine | null };

/** Rows → one group per apartment, in the order the apartments first appear.
 *  Legacy `lines` are groups of their own with no holder rows. */
function groupOrderInput(input: Pick<NewOrderInput, 'rows' | 'lines'>): OrderGroup[] {
  const groups: OrderGroup[] = [];
  if (input.rows && input.rows.length > 0) {
    const byApt = new Map<string, OrderGroup>();
    for (const r of input.rows) {
      let g = byApt.get(r.apartmentNumber);
      if (!g) {
        g = { apartmentNumber: r.apartmentNumber, chipsCount: 0, rows: [], line: null };
        byApt.set(r.apartmentNumber, g);
        groups.push(g);
      }
      g.chipsCount += r.chipsCount;
      g.rows.push(r);
    }
  } else {
    for (const l of input.lines ?? []) groups.push({ apartmentNumber: l.apartmentNumber, chipsCount: l.chipsCount, rows: [], line: l });
  }
  if (groups.length === 0) throw new Error('no_lines');
  return groups;
}

/** The total an order of these rows costs under these settings — the same
 *  computation createChipOrder / updatePendingChipOrder freeze on the order. */
export function chipOrderTotalOf(input: Pick<NewOrderInput, 'rows' | 'lines'>, settings: ChipOrderSettings): number {
  return orderTotal(groupOrderInput(input).map((g) => priceLine(g.chipsCount, settings)));
}

async function priceGroups(client: PoolClient, groups: OrderGroup[], settings: ChipOrderSettings) {
  const owners = await ownersOf(client, groups.map((g) => g.apartmentNumber));
  const priced = groups.map((g) => {
    const o = owners.get(g.apartmentNumber);
    if (!o) throw new Error('apartment_not_found');
    return { group: g, owner: o, price: priceLine(g.chipsCount, settings) };
  });
  return { priced, total: orderTotal(priced.map((p) => p.price)) };
}

/**
 * Creates the order and its lines in one transaction, status pending_payment.
 * The price is computed HERE from the settings (never from the browser) and
 * frozen on every line. Throws 'apartment_not_found' for an unknown apartment.
 */
export async function createChipOrder(input: NewOrderInput, settings: ChipOrderSettings): Promise<CreatedOrder> {
  const trackingToken = randomBytes(32).toString('base64url');
  const groups = groupOrderInput(input);

  return withTransaction(async (client) => {
    const { priced, total } = await priceGroups(client, groups, settings);
    const parts = input.addressParts ?? null;

    const order = (
      await client.query<{ id: string; order_number: number }>(
        `insert into public.chip_orders
           (full_name, phone_e164, email, address, role, total, tracking_token, created_ip, is_test, phone_verified,
            address_street, address_city, address_zip, renter_terms_accepted_at, internal_note)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13, case when $14::boolean then now() else null end, $15)
         returning id, order_number`,
        [input.fullName, input.phoneE164, input.email, input.address, input.role, total, trackingToken, input.ip, input.isTest === true,
          input.phoneVerified === undefined ? null : input.phoneVerified, parts?.street ?? null, parts?.city ?? null, parts?.zip ?? null,
          input.renterTermsAccepted === true, input.note?.trim() ? input.note.trim() : null],
      )
    ).rows[0];

    await insertOrderLines(client, order.id, priced, input);
    return {
      id: order.id,
      orderNumber: order.order_number,
      trackingToken,
      total,
      apartments: priced.map((p) => p.owner.apartment),
    };
  });
}

/** A lease already stored on THIS order, reused by a row of the update. */
export interface ReusedLease { reuseKey: string }

export interface UpdatedOrder extends CreatedOrder {
  /** The total the order had before this update. */
  previousTotal: number;
  /** Lease files the order held before and no row holds now — the caller
   *  removes them from Storage once this committed. */
  droppedLeaseKeys: string[];
  /** The stored lease of every row, aligned with input.rows. */
  leaseKeys: (string | null)[];
}

/**
 * The order form saves its order as soon as the details are complete
 * (26/11/2026), and saves it again when they change before the payment: this
 * REPLACES the content of an order that still waits for payment — the
 * contact block, the note, the renter commitment, and every apartment line
 * and holder line (deleted and written again, priced again from the settings).
 *
 * Only the order the tracking token names, only while it is a web order in
 * pending_payment with no card charge recorded, and only of the same kind
 * (test / real) as the request. Anything else throws ChipOrderStateError
 * ('not_pending'). A row may keep a lease the order already holds (`reuseKey`
 * — it must be one of THIS order's own files, else 'lease_not_found'); the
 * files no row keeps are returned for the caller to delete.
 *
 * Whether a charge may already exist on an earlier payment session is the
 * caller's to rule out BEFORE a total changes (the route asks PayPlus).
 */
export async function updatePendingChipOrder(
  trackingToken: string,
  input: Omit<NewOrderInput, 'rows' | 'lines' | 'ip' | 'phoneVerified'> & {
    rows: (Omit<NewOrderRow, 'lease'> & { lease: NewOrderRow['lease'] | ReusedLease | null })[];
  },
  settings: ChipOrderSettings,
): Promise<UpdatedOrder> {
  if (!/^[A-Za-z0-9_-]{32,64}$/.test(trackingToken)) throw new ChipOrderStateError('not_pending');
  return withTransaction(async (client) => {
    const o = (
      await client.query<{ id: string; order_number: number; status: ChipOrderStatus; source: string; is_test: boolean; total: number; card_status: string | null }>(
        `select id, order_number, status, source, is_test, total::float8 as total, card_status
           from public.chip_orders where tracking_token = $1 for update`,
        [trackingToken],
      )
    ).rows[0];
    if (!o || o.source !== 'web' || o.status !== 'pending_payment' || o.card_status === 'paid' || o.is_test !== (input.isTest === true)) {
      throw new ChipOrderStateError('not_pending');
    }
    // The leases the order holds now (holder lines; a legacy apartment line's too).
    const held = (
      await client.query<{ key: string; name: string; mime: string; size: number }>(
        `select lease_file_key as key, lease_file_name as name, lease_file_mime as mime, lease_file_size as size
           from public.chip_order_holders where order_id = $1 and lease_file_key is not null
         union
         select lease_file_key, lease_file_name, lease_file_mime, lease_file_size
           from public.chip_order_items where order_id = $1 and lease_file_key is not null`,
        [o.id],
      )
    ).rows;
    const heldByKey = new Map(held.map((h) => [h.key, h]));
    const kept = new Set<string>();
    const rows: NewOrderRow[] = input.rows.map((r) => {
      if (r.lease && 'reuseKey' in r.lease) {
        const h = heldByKey.get(r.lease.reuseKey);
        if (!h) throw new ChipOrderStateError('lease_not_found');
        kept.add(h.key);
        return { ...r, lease: { objectKey: h.key, fileName: h.name, mime: h.mime, size: Number(h.size) } };
      }
      return { ...r, lease: r.lease };
    });
    const groups = groupOrderInput({ rows });
    const { priced, total } = await priceGroups(client, groups, settings);
    const parts = input.addressParts ?? null;

    await client.query(`delete from public.chip_order_holders where order_id = $1`, [o.id]);
    await client.query(`delete from public.chip_order_items where order_id = $1`, [o.id]);
    await client.query(
      `update public.chip_orders
          set full_name = $2, phone_e164 = $3, email = $4, address = $5, role = $6, total = $7,
              address_street = $8, address_city = $9, address_zip = $10,
              renter_terms_accepted_at = case when $11::boolean then coalesce(renter_terms_accepted_at, now()) else null end,
              internal_note = $12, updated_at = now()
        where id = $1`,
      [o.id, input.fullName, input.phoneE164, input.email, input.address, input.role, total,
        parts?.street ?? null, parts?.city ?? null, parts?.zip ?? null,
        input.renterTermsAccepted === true, input.note?.trim() ? input.note.trim() : null],
    );
    await insertOrderLines(client, o.id, priced, { role: input.role, phoneE164: input.phoneE164 });
    return {
      id: o.id,
      orderNumber: o.order_number,
      trackingToken,
      total,
      previousTotal: o.total,
      apartments: priced.map((p) => p.owner.apartment),
      droppedLeaseKeys: held.map((h) => h.key).filter((k) => !kept.has(k)),
      leaseKeys: rows.map((r) => r.lease?.objectKey ?? null),
    };
  });
}

async function insertOrderLines(
  client: PoolClient,
  orderId: string,
  priced: { group: OrderGroup; owner: ApartmentOwners; price: ReturnType<typeof priceLine> }[],
  input: Pick<NewOrderInput, 'role' | 'phoneE164'>,
): Promise<void> {
  const order = { id: orderId };
  let position = 0;
  for (const { group, owner, price } of priced) {
    // The match is read from the apartment's FIRST row (its role and phone);
    // a legacy line uses the order's own role and phone.
    const first = group.rows[0];
    const match: ChipOrderMatchStatus = chipOrderMatchStatus({
      role: first ? first.role : input.role,
      orderPhoneE164: first ? first.phoneE164 : input.phoneE164,
      ownerPhonesE164: owner.phones,
      ownerOnFile: owner.onFile,
    });
    const line = group.line;
    const item = (
      await client.query<{ id: string }>(
        `insert into public.chip_order_items
           (order_id, contact_id, apartment_number, chips_count, unit_price, threshold, price_above, line_total,
            lease_file_key, lease_file_name, lease_file_mime, lease_file_size, lease_end_date, match_status)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
         returning id`,
        [
          order.id, owner.contactId, owner.apartment, group.chipsCount,
          price.unitPrice, price.threshold, price.priceAbove, price.lineTotal,
          line?.lease?.objectKey ?? null, line?.lease?.fileName ?? null, line?.lease?.mime ?? null, line?.lease?.size ?? null,
          line?.leaseEndDate ?? null, match,
        ],
      )
    ).rows[0];
    for (const r of group.rows) {
      await client.query(
        `insert into public.chip_order_holders
           (order_id, item_id, position, source, role, full_name, phone, email, chips_count,
            lease_file_key, lease_file_name, lease_file_mime, lease_file_size, lease_end_date)
         values ($1,$2,$3,'order',$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
        [
          order.id, item.id, position++, r.role, r.fullName, r.phoneE164, r.email, r.chipsCount,
          r.lease?.objectKey ?? null, r.lease?.fileName ?? null, r.lease?.mime ?? null, r.lease?.size ?? null,
          r.leaseEndDate,
        ],
      );
    }
  }
}

/** "סיים הזמנת בדיקה" (only while the sandbox is not configured — CI): a TEST
 *  order goes pending_payment → paid, with no processor field and no invoice.
 *  Matched by its tracking token AND is_test, so it can never touch an order
 *  created without the test link. Returns the order id for the call that made
 *  the transition, else null. */
export async function markTestChipOrderPaid(trackingToken: string, now: Date = new Date()): Promise<string | null> {
  if (!/^[A-Za-z0-9_-]{32,64}$/.test(trackingToken)) return null;
  const r = await queryOne<{ id: string }>(
    `update public.chip_orders
        set status = 'paid', paid_at = $2, due_at = $3, updated_at = now()
      where tracking_token = $1 and is_test and status = 'pending_payment'
      returning id`,
    [trackingToken, now.toISOString(), chipOrderDueAt(now).toISOString()],
  );
  return r?.id ?? null;
}

export interface TrackView {
  /** Internal — used to re-check a payment, never rendered. */
  id: string;
  order_number: number;
  status: ChipOrderStatus;
  due_at: string | null;
  reject_reason: string | null;
  refund_status: ChipOrderRefundStatus | null;
  /** Internal — the environment of the order's card sessions (to re-check). */
  card_env: 'sandbox' | 'production' | null;
  /** The Morning document's link, once it was issued (never on a test order). */
  invoice_url: string | null;
}

/** The public tracking page — status, due date and (from the settings) the
 *  pickup text. Nothing else about the order. */
export async function getChipOrderTrackView(token: string): Promise<TrackView | null> {
  if (!/^[A-Za-z0-9_-]{32,64}$/.test(token)) return null;
  return queryOne<TrackView>(
    `select id, order_number, status, due_at, reject_reason, refund_status, card_env,
            case when is_test then null else invoice_url end as invoice_url
       from public.chip_orders where tracking_token = $1`,
    [token],
  );
}

// ── Notifications ──────────────────────────────────────────────────────────

export interface OrderForNotify {
  id: string;
  order_number: number;
  full_name: string;
  phone_e164: string;
  email: string;
  status: ChipOrderStatus;
  tracking_token: string;
  due_at: string | null;
  reject_reason: string | null;
  refund_status: ChipOrderRefundStatus | null;
  invoice_url: string | null;
  total: number;
  /** What was refunded through PayPlus (26/11/2026), when anything was. */
  refunded_amount: number | null;
  apartments: string[];
  is_test: boolean;
  /** 'reception' orders are handled in person — they send no message. */
  source: string;
}

export async function getOrderForNotify(orderId: string): Promise<OrderForNotify | null> {
  return queryOne<OrderForNotify>(
    `select o.id, o.order_number, o.full_name, o.phone_e164, o.email, o.status, o.tracking_token,
            o.due_at, o.reject_reason, o.refund_status, o.invoice_url, o.total::float8 as total, o.is_test,
            o.refunded_amount::float8 as refunded_amount, o.source,
            array(select i.apartment_number from public.chip_order_items i
                   where i.order_id = o.id order by i.created_at) as apartments
       from public.chip_orders o where o.id = $1`,
    [orderId],
  );
}

export async function recordChipOrderNotification(row: {
  orderId: string;
  kind: ChipOrderNotifyKind;
  channel: 'email' | 'whatsapp';
  status: 'sent' | 'failed' | 'skipped';
  error?: string | null;
}): Promise<void> {
  await query(
    `insert into public.chip_order_notifications (order_id, kind, channel, status, error)
     values ($1,$2,$3,$4,$5)`,
    [row.orderId, row.kind, row.channel, row.status, row.error ? row.error.slice(0, 500) : null],
  );
}

// ── The staff screen (/chips → הזמנות) ─────────────────────────────────────

const OPEN_SQL = `('paid', 'approved', 'ready')`;

/** The Orders tab: ONE ROW PER APARTMENT of every open order (paid — being
 *  assigned — or ready). pending_payment never shows; a row leaves once its
 *  order is collected or rejected — EXCEPT a reception order (25/11/2026),
 *  which is collected the moment it is made and stays in the tab, after the
 *  open orders, newest first, tagged "קבלה" — also once it was cancelled
 *  (stored `rejected`, shown "בוטל"). The open orders are ONE group, newest
 *  payment first, whatever their stage (25/11/2026): a ready order keeps the
 *  place it had. Until then every paid order came before every ready one, so
 *  after "מוכן לאיסוף" the order's row jumped down, and the row left in its
 *  place was another order, still waiting. Test orders come with is_test;
 *  the screen badges them and keeps them out of every count. `people` — the people of
 *  the apartment line (the search, the Excel file and the print view of the
 *  tab, 24/11/2026): the names of its holder lines, in the order of the
 *  window's blocks. A line with no holder line of the order itself — an order
 *  made before 20/11/2026 — starts with whoever ordered, so the person who
 *  paid is never missing, also when the staff added somebody to it. */
export async function listOpenChipOrderRows(): Promise<ChipOrderRow[]> {
  const r = await query<ChipOrderRow>(
    `select i.id as item_id, o.id as order_id, o.order_number, i.contact_id, i.apartment_number,
            o.full_name, o.phone_e164, o.role, o.source, o.status, i.chips_count,
            (select count(*)::int from public.chips c where c.order_item_id = i.id and c.status = 'active') as chips_linked,
            i.line_total::float8 as line_total,
            (case when exists (select 1 from public.chip_order_holders h
                                where h.item_id = i.id and h.source in ('order', 'reception'))
                  then array[]::text[] else array[o.full_name] end)
            || array(select h.full_name from public.chip_order_holders h
                      where h.item_id = i.id order by h.position, h.created_at, h.id) as people,
            (case when exists (select 1 from public.chip_order_holders h
                                where h.item_id = i.id and h.source in ('order', 'reception'))
                  then array[]::text[] else array[$1::text] end)
            || array(select h.id::text from public.chip_order_holders h
                      where h.item_id = i.id order by h.position, h.created_at, h.id) as people_keys,
            (select x.order_number from public.chip_orders x where x.id = o.extra_of_order_id) as extra_of_order_number,
            o.paid_at, o.due_at, o.created_at,
            exists (select 1 from public.chip_order_notifications n
                     where n.order_id = o.id and n.status = 'failed') as has_failed_notification,
            o.is_test, o.phone_verified,
            o.payment_method, o.card_status, o.card_env, o.refund_status, o.refunded_amount::float8 as refunded_amount,
            -- A refund call with no answer recorded (27/11/2026: it is never
            -- sent again, so it stays "on its way" until PayPlus shows it).
            (o.refund_requested_at is not null and o.refunded_at is null) as refund_in_flight,
            o.cancel_failed_step, o.cancel_error,
            case when o.cancel_completed_at is null then o.payplus_reversal_kind end as payplus_reversal_kind,
            (o.cancel_completed_at is not null) as cancel_completed,
            o.closed_by_hand_step,
            (select json_build_object('status', d.status, 'number', d.morning_docs->0->>'number', 'url', d.morning_docs->0->>'url')
               from public.chip_order_documents d
              where d.order_id = o.id and d.kind = 'invoice'
              order by d.created_at limit 1) as invoice_doc
       from public.chip_order_items i
       join public.chip_orders o on o.id = i.order_id
      where o.status in ${OPEN_SQL} or (o.source = 'reception' and o.status in ('collected', 'rejected'))
         or (o.source = 'web' and o.refunded_at is not null)
         -- A web order PayPlus shows cancelled, or whose "ביטול וזיכוי" started
         -- (27/11/2026): it waits for an admin, also once it was collected.
         or (o.source = 'web' and o.card_status = 'paid' and (o.payplus_reversal_at is not null or o.cancel_requested_at is not null))
      order by case when o.status in ('collected', 'rejected') then 1 else 0 end,
               o.paid_at desc nulls last, o.order_number desc, i.created_at`,
    [PICKUP_ORDERER_KEY],
  );
  return r.rows;
}

/**
 * What the issue window loads for one Orders-tab row: the apartment, the
 * clicked row's orderer (the holder block is matched by that phone or
 * prefilled from it), and EVERY open order of the same person (same phone)
 * for this apartment — one "פרטי הזמנה" section each, oldest first. Null when
 * the line does not exist or its order was never paid.
 */
export async function getChipOrderSheetContext(itemId: string): Promise<ChipOrderSheetContext | null> {
  const head = await queryOne<{ contact_id: string; apartment_number: string; full_name: string; phone_e164: string; role: ChipOrderRole }>(
    `select i.contact_id, c.apartment_number, o.full_name, o.phone_e164, o.role
       from public.chip_order_items i
       join public.chip_orders o on o.id = i.order_id
       join public.contacts c on c.id = i.contact_id
      where i.id = $1 and o.status <> 'pending_payment'`,
    [itemId],
  );
  if (!head) return null;
  const sections = (
    await query<ChipOrderSection>(
      `select o.id as order_id, o.order_number, i.id as item_id, o.full_name, o.phone_e164, o.email, o.address,
              o.role, o.status, o.total::float8 as total, i.chips_count,
              (select count(*)::int from public.chips ch where ch.order_item_id = i.id and ch.status = 'active') as chips_linked,
              i.lease_file_key, i.lease_file_name, to_char(i.lease_end_date, 'YYYY-MM-DD') as lease_end_date,
              o.paid_at, o.due_at, o.created_at, o.is_test, o.phone_verified,
              array(select x.apartment_number from public.chip_order_items x
                     where x.order_id = o.id and x.id <> i.id order by x.created_at) as other_apartments,
              not exists (select 1 from public.chip_order_items x
                           where x.order_id = o.id
                             and (select count(*) from public.chips ch
                                   where ch.order_item_id = x.id and ch.status = 'active') < x.chips_count) as order_all_linked
         from public.chip_order_items i
         join public.chip_orders o on o.id = i.order_id
        where i.contact_id = $1 and o.phone_e164 = $2 and o.status in ${OPEN_SQL}
        order by o.created_at, o.order_number`,
      [head.contact_id, head.phone_e164],
    )
  ).rows;
  return {
    contact_id: head.contact_id,
    apartment_number: head.apartment_number,
    holder: { full_name: head.full_name, phone_e164: head.phone_e164, role: head.role },
    sections,
  };
}

const REGISTRY_COLS: Record<ChipOrderRole, { name: string; phone: string }> = {
  owner: { name: 'owner_name', phone: 'owner_phone' },
  tenant: { name: 'tenant_name', phone: 'tenant_phone' },
  operator: { name: 'operator_name', phone: 'operator_phone' },
};

async function lockOrder(client: PoolClient, id: string): Promise<{ status: ChipOrderStatus; role: ChipOrderPersonRole; source: string } | null> {
  return (
    (
      await client.query<{ status: ChipOrderStatus; role: ChipOrderPersonRole; source: string }>(
        `select status, role, source from public.chip_orders where id = $1 for update`,
        [id],
      )
    ).rows[0] ?? null
  );
}

/**
 * "עדכן בכרטיס הדייר" (13/11/2026) — copies the holder block's NAME and PHONE
 * (as typed in the window) into the tenants list of the line's apartment, in
 * the slot of the order's role (owner_* / tenant_* / operator_*), through the
 * same updateContact the apartment card uses — so the portal roster triggers
 * fire exactly as on a manual edit (an owner phone opens the portal). Only on
 * that click: nothing else in the order flow writes to the tenants list. An
 * empty value is left out, never cleared. Only while the order is open.
 * Returns what was written, for the audit row; null when the line is unknown.
 */
export async function writeOrderHolderToRegistry(
  itemId: string,
  values: { name: string | null; phone: string | null },
  /** The block's own role (20/11/2026: a block per person). Absent = the order's. */
  roleOverride?: ChipOrderRole,
): Promise<{ order_id: string; contact_id: string; apartment_number: string; role: ChipOrderRole; fields: Record<string, string | null> } | null> {
  return withTransaction(async (client) => {
    const item = (
      await client.query<{ order_id: string; contact_id: string; apartment_number: string }>(
        `select order_id, contact_id, apartment_number from public.chip_order_items where id = $1`,
        [itemId],
      )
    ).rows[0];
    if (!item) return null;
    const order = await lockOrder(client, item.order_id);
    if (!order) return null;
    if (!isOpenChipOrder(order.status)) throw new ChipOrderStateError('not_open');
    const role = roleOverride ?? order.role;
    // Only a role the tenants list has a slot for (a reception order may be a
    // guest's; it is closed by then anyway — the check above).
    if (role !== 'owner' && role !== 'tenant' && role !== 'operator') throw new ChipOrderStateError('nothing_to_write');
    const cols = REGISTRY_COLS[role];
    const body: Record<string, unknown> = {};
    if (values.name?.trim()) body[cols.name] = values.name.trim();
    if (values.phone?.trim()) body[cols.phone] = values.phone.trim();
    if (Object.keys(body).length === 0) throw new ChipOrderStateError('nothing_to_write');
    const coerced = coerceContactInput(body, 'update');
    if (!coerced.ok) throw new ChipOrderStateError(coerced.error);
    await updateContact(item.contact_id, coerced.fields, client);
    return {
      order_id: item.order_id,
      contact_id: item.contact_id,
      apartment_number: item.apartment_number,
      role,
      fields: coerced.fields as Record<string, string | null>,
    };
  });
}

/** A signed callback made PayPlus show this order's charge cancelled or
 *  refunded, and "ביטול וזיכוי" has not finished it (27/11/2026). */
async function reversedInPayPlus(client: PoolClient, id: string): Promise<boolean> {
  const r = await client.query(
    `select 1 from public.chip_orders where id = $1 and payplus_reversal_at is not null and cancel_completed_at is null`, [id]);
  return (r.rowCount ?? 0) > 0;
}

/** paid → ready, only when every line has all its chips linked (ACTIVE). */
export async function markChipOrderReady(id: string): Promise<boolean | null> {
  return withTransaction(async (client) => {
    const order = await lockOrder(client, id);
    if (!order) return null;
    if (order.status !== 'paid' && order.status !== 'approved') throw new ChipOrderStateError('not_assigning');
    // PayPlus showed the charge cancelled / refunded (27/11/2026): the money
    // went back — nothing moves the order on until "ביטול וזיכוי".
    if (await reversedInPayPlus(client, id)) throw new ChipOrderStateError('payplus_reversed');
    const missing = (
      await client.query<{ missing: number }>(
        `select count(*)::int as missing
           from public.chip_order_items i
          where i.order_id = $1
            and (select count(*) from public.chips c
                  where c.order_item_id = i.id and c.status = 'active') < i.chips_count`,
        [id],
      )
    ).rows[0].missing;
    if (missing > 0) throw new ChipOrderStateError('chips_missing');
    await client.query(
      `update public.chip_orders set status = 'ready', ready_at = now(), updated_at = now() where id = $1`,
      [id],
    );
    return true;
  });
}

/** Where an order is marked collected: the guard's pickup screen, or the
 *  management's own screens (the orders table, the issue window). */
export type ChipHandoverVia = 'pickup' | 'management';

export interface ChipHandover {
  order_number: number;
  /** The person who collected, by name — null when nobody was named. */
  collector_name: string | null;
}

/** The person of the order that `key` names — a holder line of THIS order, or
 *  its orderer when the order has an apartment line with no person of its own
 *  (an order made before 20/11/2026). Anything else is not a person of the
 *  order: the name is always read here, never taken from a request. */
async function resolveCollector(
  client: PoolClient,
  orderId: string,
  ordererName: string,
  key: string,
): Promise<{ holderId: string | null; name: string }> {
  if (!isPickupPersonKey(key)) throw new ChipOrderStateError('collector_not_in_order');
  if (key === PICKUP_ORDERER_KEY) {
    const old = await client.query(
      `select 1 from public.chip_order_items i
        where i.order_id = $1
          and not exists (select 1 from public.chip_order_holders h
                           where h.item_id = i.id and h.source in ('order', 'reception'))
        limit 1`,
      [orderId],
    );
    if ((old.rowCount ?? 0) === 0) throw new ChipOrderStateError('collector_not_in_order');
    return { holderId: null, name: ordererName };
  }
  const holder = (
    await client.query<{ id: string; full_name: string }>(
      `select id, full_name from public.chip_order_holders where id = $1 and order_id = $2`,
      [key, orderId],
    )
  ).rows[0];
  if (!holder) throw new ChipOrderStateError('collector_not_in_order');
  return { holderId: holder.id, name: holder.full_name };
}

/**
 * ready → collected ("נאסף" / "נמסר") — the row leaves the Orders tab. ONE
 * function for both places an order is handed over:
 *   · the guard's pickup screen (`via: 'pickup'`): the person who showed an ID
 *     must be named, and must be a person of the order;
 *   · the management (`via: 'management'`): naming that person is optional.
 * Only an order that is READY moves — anything else is refused (`not_ready`),
 * whoever asks. On the pickup screen an order with NO active chip is refused
 * too (`no_active_chips`): there is nothing to hand over, and what happened to
 * its chips is the management's to sort out. Who handed over, where, when and who collected are stored on
 * the order, and the audit row is written in the SAME transaction: a hand-over
 * and its trail are one fact. Nobody is notified (as before). Null when the
 * order does not exist.
 */
export async function markChipOrderCollected(
  id: string,
  by: { id: string; name: string },
  opts: { via: ChipHandoverVia; collector?: string | null },
): Promise<ChipHandover | null> {
  return withTransaction(async (client) => {
    const order = (
      await client.query<{ status: ChipOrderStatus; order_number: number; full_name: string }>(
        `select status, order_number, full_name from public.chip_orders where id = $1 for update`,
        [id],
      )
    ).rows[0];
    if (!order) return null;
    if (order.status !== 'ready') throw new ChipOrderStateError('not_ready');
    if (await reversedInPayPlus(client, id)) throw new ChipOrderStateError('payplus_reversed');
    const key = opts.collector?.trim() || null;
    if (!key && opts.via === 'pickup') throw new ChipOrderStateError('collector_required');
    const collector = key ? await resolveCollector(client, id, order.full_name, key) : null;
    if (opts.via === 'pickup') {
      // The same chips the pickup list shows: the order's own, and the paid
      // extras that were added for its people.
      const any = await client.query(
        `select 1 from public.chips c
          where c.status = 'active'
            and (c.order_item_id in (select i.id from public.chip_order_items i where i.order_id = $1)
              or c.order_holder_id in (select e.id from public.chip_order_holders e
                                         join public.chip_order_holders h on h.id = e.extra_of_holder_id
                                        where h.order_id = $1))
          limit 1`,
        [id],
      );
      if ((any.rowCount ?? 0) === 0) throw new ChipOrderStateError('no_active_chips');
    }
    await client.query(
      `update public.chip_orders
          set status = 'collected', collected_at = now(),
              collected_by_name = $2, collected_holder_id = $3,
              handed_over_by = $4, handed_over_by_name = $5, handed_over_via = $6,
              updated_at = now()
        where id = $1`,
      [id, collector?.name ?? null, collector?.holderId ?? null, by.id, by.name, opts.via],
    );
    await writeAuditInTx(client, {
      actorUserId: by.id,
      action: 'collected',
      entityType: 'chip_order',
      entityId: id,
      metadata: {
        via: opts.via,
        order_number: order.order_number,
        // Who collected: the person's holder line (null = the orderer of an
        // order with no holder lines), and the name as it stood right then.
        collector: collector ? (collector.holderId ? 'holder' : 'orderer') : null,
        collector_holder_id: collector?.holderId ?? null,
        collector_name: collector?.name ?? null,
      },
    });
    return { order_number: order.order_number, collector_name: collector?.name ?? null };
  });
}

/**
 * "בטל הזמנת קבלה" (25/11/2026) — a reception order is real: it has no test
 * mode and is collected the moment it is made, so nothing else undoes one. The
 * cancellation, in ONE transaction:
 *   · only a RECEPTION order that is still collected (`not_reception` /
 *     `not_cancellable` otherwise — a web order is rejected through its own
 *     flow, with its refund);
 *   · every ACTIVE chip of the order is disabled — never deleted — with a chip
 *     event each, exactly like the switch in the issue window. A chip that was
 *     moved to another apartment since (its contact is no longer the line's)
 *     is somebody else's chip now: it is left alone and counted in the audit;
 *   · the order is stored `rejected` with the reason (the existing status: a
 *     new one would mean rewriting the status CHECK), plus who cancelled it;
 *   · the audit row, in the same transaction.
 * No message goes to anyone, and no refund is recorded: what happens to the
 * cash is between the management and the customer. Null when the order does
 * not exist.
 */
export async function cancelReceptionOrder(
  id: string,
  reason: string,
  by: { id: string; name: string },
  /** "ביטול וזיכוי" (27/11/2026): what its earlier steps did, for the audit row. */
  steps?: Record<string, unknown>,
): Promise<{ order_number: number; chips_disabled: number; payment_method: string | null; card_paid: boolean } | null> {
  return withTransaction(async (client) => {
    const order = (
      await client.query<{ status: ChipOrderStatus; source: string; order_number: number; total: number; payment_method: string | null; card_status: string | null; is_test: boolean }>(
        `select status, source, order_number, total::float8 as total, payment_method, card_status, is_test
           from public.chip_orders where id = $1 for update`,
        [id],
      )
    ).rows[0];
    if (!order) return null;
    if (order.source !== 'reception') throw new ChipOrderStateError('not_reception');
    // A collected order; or (26/11/2026) a reception order the card PAID whose
    // chips were never issued (the window was closed after the payment).
    const paidByCardNoChips = order.status === 'paid' && order.payment_method === 'card' && order.card_status === 'paid';
    if (order.status !== 'collected' && !paidByCardNoChips) throw new ChipOrderStateError('not_cancellable');
    const active = (
      await client.query<{ id: string; moved: boolean }>(
        `select c.id, (c.contact_id is distinct from i.contact_id) as moved
           from public.chips c
           join public.chip_order_items i on i.id = c.order_item_id
          where i.order_id = $1 and c.status = 'active'
          order by c.issued_at, c.id
          for update of c`,
        [id],
      )
    ).rows;
    const chips = active.filter((c) => !c.moved);
    for (const c of chips) {
      await deactivateChipInTx(client, c.id, { reason: 'unknown', note: `ביטול הזמנת קבלה ${order.order_number}` }, by);
    }
    await client.query(
      `update public.chip_orders
          set status = 'rejected', rejected_at = now(), reject_reason = $2,
              cancelled_by = $3, cancelled_by_name = $4,
              cancel_failed_step = null, cancel_error = null, cancel_running_until = null,
              -- The run of "ביטול וזיכוי" is finished (27/11/2026), and a
              -- warning of a cancellation seen in PayPlus is settled by it.
              cancel_completed_at = case when cancel_requested_at is not null then now() end,
              payplus_reversal_at = null, payplus_reversal_kind = null,
              updated_at = now()
        where id = $1`,
      [id, reason, by.id, by.name],
    );
    // The money of a cash / bank-transfer order goes back by hand; its Morning
    // document is credited here, in the same transaction (26/11/2026) — only
    // when the order HAS a document (orders recorded before 26/11/2026, as
    // "מזומן או העברה", have none). A card is refunded through PayPlus by the
    // step before (refundCharge, src/lib/chipOrders/refund.ts), which queues
    // that credit itself.
    if (order.payment_method === 'cash' || order.payment_method === 'bank_transfer') {
      const invoice = await getInvoiceRowOfOrderInTx(client, id);
      if (invoice) {
        await enqueueDocumentInTx(client, {
          orderId: id,
          kind: 'credit',
          paymentKey: `cancel:${id}`,
          amount: order.total,
          method: order.payment_method,
          details: { date: israelDate(), cancelled_by: by.name },
          creditOf: invoice.id,
        });
      }
    }
    await writeAuditInTx(client, {
      actorUserId: by.id,
      action: 'reception_cancelled',
      entityType: 'chip_order',
      entityId: id,
      metadata: {
        source: 'reception', order_number: order.order_number, reason,
        amount: order.total, chips_disabled: chips.length,
        chips_left_moved: active.length - chips.length, payment_method: order.payment_method,
        ...(steps ? { steps } : {}),
      },
    });
    return {
      order_number: order.order_number,
      chips_disabled: chips.length,
      payment_method: order.payment_method,
      card_paid: order.payment_method === 'card' && order.card_status === 'paid',
    };
  });
}

export interface RejectedOrder {
  total: number;
  grow_transaction_id: string | null;
  grow_transaction_token: string | null;
  is_test: boolean;
  /** 'paid' when the processor confirmed a card charge — then it is refunded through PayPlus. */
  card_status: string | null;
}

/** paid → rejected with a reason ('approved' = legacy paid). The refund runs
 *  after this commits (setChipOrderRefund records its outcome). A WEB order
 *  only: a reception order — also one a card paid whose chips were never
 *  issued — is undone by "בטל הזמנת קבלה" alone (admins only; its chips are
 *  disabled and its card refunded with it), never by "דחה". */
export async function rejectChipOrder(id: string, reason: string): Promise<RejectedOrder | null> {
  return withTransaction(async (client) => {
    const order = await lockOrder(client, id);
    if (!order) return null;
    if (order.source === 'reception') throw new ChipOrderStateError('not_web_order');
    if (order.status !== 'paid' && order.status !== 'approved') throw new ChipOrderStateError('not_rejectable');
    // A refunded order must not leave working chips behind: active chips issued
    // for it are deactivated first (in the issue window), then the order rejected.
    const active = (
      await client.query<{ n: number }>(
        `select count(*)::int as n from public.chips c
           join public.chip_order_items i on i.id = c.order_item_id
          where i.order_id = $1 and c.status = 'active'`,
        [id],
      )
    ).rows[0].n;
    if (active > 0) throw new ChipOrderStateError('chips_active');
    const r = (
      await client.query<RejectedOrder>(
        `update public.chip_orders
            set status = 'rejected', rejected_at = now(), reject_reason = $2, updated_at = now()
          where id = $1
          returning total::float8 as total, grow_transaction_id, grow_transaction_token, is_test, card_status`,
        [id, reason],
      )
    ).rows[0];
    return r;
  });
}

export async function setChipOrderRefund(id: string, status: ChipOrderRefundStatus, note: string | null): Promise<void> {
  // A refund that was recorded meanwhile (27/11/2026 — an admin's "ביטול
  // וזיכוי" running at the same moment) is never overwritten.
  await query(
    `update public.chip_orders set refund_status = $2, refund_note = $3, updated_at = now()
      where id = $1 and refunded_at is null`,
    [id, status, note ? note.slice(0, 500) : null],
  );
}

// ── Cleanup: stale unpaid orders (hourly) and test orders (by hand) ────────

export interface StaleUnpaidOrder {
  id: string;
  order_number: number;
  /** A payment process of the former processor (Grow, removed 26/11/2026) —
   *  such an order can no longer be checked, so it is never purged. */
  grow_process_id: string | null;
  /** The environment of the order's card sessions, when it had any. */
  card_env: 'sandbox' | 'production' | null;
  sessions: number;
}

/** Real orders still pending_payment (never paid) that were created more than
 *  `hours` ago — the hourly purge's candidates, oldest first. Test orders are
 *  never purged here (they are deleted only by hand). An order whose payment
 *  page was opened in the last SESSION_LOOKUP_MINUTES is not a candidate: that
 *  page may still be charged (the delete checks it again, under the row lock). */
export async function listStaleUnpaidOrders(hours: number, limit = 200): Promise<StaleUnpaidOrder[]> {
  const r = await query<StaleUnpaidOrder>(
    `select o.id, o.order_number, o.grow_process_id, o.card_env,
            (select count(*)::int from public.chip_order_card_sessions s where s.order_id = o.id) as sessions
       from public.chip_orders o
      where o.status = 'pending_payment' and o.paid_at is null and not o.is_test
        and o.created_at < now() - make_interval(hours => $1)
        and (o.card_session_at is null or o.card_session_at < now() - make_interval(mins => $3))
        and not exists (select 1 from public.chip_order_card_sessions s
                         where s.order_id = o.id and s.created_at >= now() - make_interval(mins => $3))
      order by o.created_at
      limit $2`,
    [hours, limit, SESSION_LOOKUP_MINUTES],
  );
  return r.rows;
}

export type OrderDeleteOutcome = 'deleted' | 'not_found' | 'file_failed';

/**
 * Deletes ONE order with its lease files: the files first, then the row (its
 * lines and notifications go with it — ON DELETE CASCADE; a chip issued for
 * one of its lines stays in the chips module, its order_item_id set NULL by
 * the FK). The row is locked for the whole operation and must still match:
 *   'unpaid' — a REAL order still pending_payment that was never paid, whose
 *              payment page was not opened in the last SESSION_LOOKUP_MINUTES
 *              (setCardSession stamps card_session_at under this same row
 *              lock, so a page opened after the purge's lookup keeps the
 *              order). A paid order, in any status, is never deleted.
 *   'test'   — a test order (is_test), in any status.
 * If Storage refuses a file, nothing is deleted: the row stays and the next
 * attempt retries (`file_failed`).
 */
export async function deleteChipOrderWithLeases(
  id: string,
  which: 'unpaid' | 'test',
  removeLeases: (objectKeys: string[]) => Promise<boolean>,
): Promise<OrderDeleteOutcome> {
  return withTransaction(async (client) => {
    const locked = which === 'unpaid'
      ? await client.query(
        `select id from public.chip_orders
          where id = $1 and status = 'pending_payment' and paid_at is null and not is_test
            and (card_session_at is null or card_session_at < now() - make_interval(mins => $2))
          for update`,
        [id, SESSION_LOOKUP_MINUTES],
      )
      : await client.query(`select id from public.chip_orders where id = $1 and is_test for update`, [id]);
    if ((locked.rowCount ?? 0) === 0) return 'not_found';
    const keys = (
      await client.query<{ k: string }>(
        `select lease_file_key as k from public.chip_order_items
          where order_id = $1 and lease_file_key is not null
         union
         select lease_file_key as k from public.chip_order_holders
          where order_id = $1 and lease_file_key is not null`,
        [id],
      )
    ).rows.map((r) => r.k);
    if (keys.length > 0 && !(await removeLeases(keys))) return 'file_failed';
    // The files are gone: so are their rows in the lease registry.
    await forgetLeaseUploads(client, keys);
    await client.query(`delete from public.chip_orders where id = $1`, [id]);
    return 'deleted';
  });
}

/** Test orders whose "סיים הזמנת בדיקה" was never pressed — not in the list
 *  (pending_payment never is), but still removed by "delete all". */
export async function countUnfinishedTestOrders(): Promise<number> {
  const r = await queryOne<{ n: number }>(
    `select count(*)::int as n from public.chip_orders where is_test and status = 'pending_payment'`,
  );
  return r?.n ?? 0;
}

/** Every test order (any status, pending_payment included — those never show
 *  in /chips, so "מחק את כל הזמנות הבדיקה" is their only way out). */
export async function listTestOrderIds(): Promise<string[]> {
  const r = await query<{ id: string }>(`select id from public.chip_orders where is_test order by created_at`);
  return r.rows.map((row) => row.id);
}
