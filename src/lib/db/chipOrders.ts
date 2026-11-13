import 'server-only';
import { randomBytes } from 'node:crypto';
import type { PoolClient } from 'pg';
import { query, queryOne, withTransaction } from '@/lib/db';
import { toPortalE164 } from '@/lib/portal/phone';
import { coerceContactInput } from '@/lib/validation/contacts';
import { updateContact } from '@/lib/db/contacts';
import { chipOrderMatchStatus } from '@/lib/chipOrders/match';
import {
  chipOrderDueAt,
  isOpenChipOrder,
  orderTotal,
  priceLine,
  type ChipOrderMatchStatus,
  type ChipOrderNotifyKind,
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

export interface NewOrderInput {
  fullName: string;
  phoneE164: string;
  email: string;
  address: string;
  role: ChipOrderRole;
  lines: NewOrderLine[];
  ip: string | null;
  /** Test mode (a valid test link): the order is marked is_test and is later
   *  "paid" by markTestChipOrderPaid, never through Grow. */
  isTest?: boolean;
  /** False only for a test order whose phone code was skipped ("דלג על אימות
   *  (מצב בדיקה)"); the database refuses false on a real order. */
  phoneVerified?: boolean;
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

/**
 * Creates the order and its lines in one transaction, status pending_payment.
 * The price is computed HERE from the settings (never from the browser) and
 * frozen on every line. Throws 'apartment_not_found' for an unknown apartment.
 */
export async function createChipOrder(input: NewOrderInput, settings: ChipOrderSettings): Promise<CreatedOrder> {
  const trackingToken = randomBytes(32).toString('base64url');
  return withTransaction(async (client) => {
    const owners = await ownersOf(client, input.lines.map((l) => l.apartmentNumber));
    const priced = input.lines.map((l) => {
      const o = owners.get(l.apartmentNumber);
      if (!o) throw new Error('apartment_not_found');
      return { line: l, owner: o, price: priceLine(l.chipsCount, settings) };
    });
    const total = orderTotal(priced.map((p) => p.price));

    const order = (
      await client.query<{ id: string; order_number: number }>(
        `insert into public.chip_orders
           (full_name, phone_e164, email, address, role, total, tracking_token, created_ip, is_test, phone_verified)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
         returning id, order_number`,
        [input.fullName, input.phoneE164, input.email, input.address, input.role, total, trackingToken, input.ip, input.isTest === true,
          input.phoneVerified !== false],
      )
    ).rows[0];

    for (const { line, owner, price } of priced) {
      const match: ChipOrderMatchStatus = chipOrderMatchStatus({
        role: input.role,
        orderPhoneE164: input.phoneE164,
        ownerPhonesE164: owner.phones,
        ownerOnFile: owner.onFile,
      });
      await client.query(
        `insert into public.chip_order_items
           (order_id, contact_id, apartment_number, chips_count, unit_price, threshold, price_above, line_total,
            lease_file_key, lease_file_name, lease_file_mime, lease_file_size, lease_end_date, match_status)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
        [
          order.id, owner.contactId, owner.apartment, line.chipsCount,
          price.unitPrice, price.threshold, price.priceAbove, price.lineTotal,
          line.lease?.objectKey ?? null, line.lease?.fileName ?? null, line.lease?.mime ?? null, line.lease?.size ?? null,
          line.leaseEndDate, match,
        ],
      );
    }
    return {
      id: order.id,
      orderNumber: order.order_number,
      trackingToken,
      total,
      apartments: priced.map((p) => p.owner.apartment),
    };
  });
}

/** Stores the Grow process of a fresh order (server-side only). */
export async function setOrderGrowProcess(orderId: string, processId: string, processToken: string): Promise<void> {
  await query(
    `update public.chip_orders
        set grow_process_id = $2, grow_process_token = $3, updated_at = now()
      where id = $1 and status = 'pending_payment'`,
    [orderId, processId, processToken],
  );
}

export interface OrderPaymentRef {
  id: string;
  status: ChipOrderStatus;
  total: number;
  grow_process_id: string | null;
  grow_process_token: string | null;
}

export async function getOrderPaymentRef(orderId: string): Promise<OrderPaymentRef | null> {
  return queryOne<OrderPaymentRef>(
    `select id, status, total::float8 as total, grow_process_id, grow_process_token
       from public.chip_orders where id = $1`,
    [orderId],
  );
}

/** pending_payment → paid, once. Returns true only for the call that made the
 *  transition (Grow repeats its callback; the second one changes nothing).
 *  The due date (72 working hours) starts here — there is no approval step
 *  (13/11/2026), and the "received & paid" message states it. */
export async function markChipOrderPaid(
  orderId: string,
  tx: { transactionId: string; transactionToken: string; asmachta: string | null },
  now: Date = new Date(),
): Promise<boolean> {
  const r = await query(
    `update public.chip_orders
        set status = 'paid', paid_at = $5, due_at = $6,
            grow_transaction_id = $2, grow_transaction_token = $3, grow_asmachta = $4,
            updated_at = now()
      where id = $1 and status = 'pending_payment'`,
    [orderId, tx.transactionId, tx.transactionToken, tx.asmachta, now.toISOString(), chipOrderDueAt(now).toISOString()],
  );
  return (r.rowCount ?? 0) > 0;
}

/** "סיים הזמנת בדיקה": a TEST order goes pending_payment → paid, with no Grow
 *  field and no invoice. Matched by its tracking token AND is_test, so it can
 *  never touch an order created without the test link. Returns the order id
 *  for the call that made the transition, else null. */
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

/** Grow's invoice callback: attach the document link to the order. */
export async function setChipOrderInvoice(
  orderId: string,
  processId: string,
  invoice: { url: string; number: string | null },
): Promise<boolean> {
  const r = await query(
    `update public.chip_orders
        set invoice_url = $3, invoice_number = $4, updated_at = now()
      where id = $1 and grow_process_id = $2`,
    [orderId, processId, invoice.url, invoice.number],
  );
  return (r.rowCount ?? 0) > 0;
}

export interface TrackView {
  /** Internal — used to re-check a payment, never rendered. */
  id: string;
  order_number: number;
  status: ChipOrderStatus;
  due_at: string | null;
  reject_reason: string | null;
  refund_status: ChipOrderRefundStatus | null;
}

/** The public tracking page — status, due date and (from the settings) the
 *  pickup text. Nothing else about the order. */
export async function getChipOrderTrackView(token: string): Promise<TrackView | null> {
  if (!/^[A-Za-z0-9_-]{32,64}$/.test(token)) return null;
  return queryOne<TrackView>(
    `select id, order_number, status, due_at, reject_reason, refund_status
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
  apartments: string[];
  is_test: boolean;
}

export async function getOrderForNotify(orderId: string): Promise<OrderForNotify | null> {
  return queryOne<OrderForNotify>(
    `select o.id, o.order_number, o.full_name, o.phone_e164, o.email, o.status, o.tracking_token,
            o.due_at, o.reject_reason, o.refund_status, o.invoice_url, o.total::float8 as total, o.is_test,
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
 *  order is collected or rejected. Test orders come with is_test; the screen
 *  badges them and keeps them out of every count. */
export async function listOpenChipOrderRows(): Promise<ChipOrderRow[]> {
  const r = await query<ChipOrderRow>(
    `select i.id as item_id, o.id as order_id, o.order_number, i.contact_id, i.apartment_number,
            o.full_name, o.phone_e164, o.role, o.status, i.chips_count,
            (select count(*)::int from public.chips c where c.order_item_id = i.id and c.status = 'active') as chips_linked,
            o.paid_at, o.due_at, o.created_at,
            exists (select 1 from public.chip_order_notifications n
                     where n.order_id = o.id and n.status = 'failed') as has_failed_notification,
            o.is_test, o.phone_verified
       from public.chip_order_items i
       join public.chip_orders o on o.id = i.order_id
      where o.status in ${OPEN_SQL}
      order by case o.status when 'ready' then 1 else 0 end, o.paid_at desc nulls last, o.order_number desc, i.created_at`,
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

async function lockOrder(client: PoolClient, id: string): Promise<{ status: ChipOrderStatus; role: ChipOrderRole } | null> {
  return (
    (
      await client.query<{ status: ChipOrderStatus; role: ChipOrderRole }>(
        `select status, role from public.chip_orders where id = $1 for update`,
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
    const cols = REGISTRY_COLS[order.role];
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
      role: order.role,
      fields: coerced.fields as Record<string, string | null>,
    };
  });
}

/** paid → ready, only when every line has all its chips linked (ACTIVE). */
export async function markChipOrderReady(id: string): Promise<boolean | null> {
  return withTransaction(async (client) => {
    const order = await lockOrder(client, id);
    if (!order) return null;
    if (order.status !== 'paid' && order.status !== 'approved') throw new ChipOrderStateError('not_assigning');
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

/** ready → collected — the row leaves the Orders tab. */
export async function markChipOrderCollected(id: string): Promise<boolean | null> {
  return withTransaction(async (client) => {
    const order = await lockOrder(client, id);
    if (!order) return null;
    if (order.status !== 'ready') throw new ChipOrderStateError('not_ready');
    await client.query(
      `update public.chip_orders set status = 'collected', collected_at = now(), updated_at = now() where id = $1`,
      [id],
    );
    return true;
  });
}

export interface RejectedOrder {
  total: number;
  grow_transaction_id: string | null;
  grow_transaction_token: string | null;
  is_test: boolean;
}

/** paid → rejected with a reason ('approved' = legacy paid). The refund runs
 *  after this commits (setChipOrderRefund records its outcome). */
export async function rejectChipOrder(id: string, reason: string): Promise<RejectedOrder | null> {
  return withTransaction(async (client) => {
    const order = await lockOrder(client, id);
    if (!order) return null;
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
          returning total::float8 as total, grow_transaction_id, grow_transaction_token, is_test`,
        [id, reason],
      )
    ).rows[0];
    return r;
  });
}

export async function setChipOrderRefund(id: string, status: ChipOrderRefundStatus, note: string | null): Promise<void> {
  await query(
    `update public.chip_orders set refund_status = $2, refund_note = $3, updated_at = now() where id = $1`,
    [id, status, note ? note.slice(0, 500) : null],
  );
}

// ── Cleanup: stale unpaid orders (hourly) and test orders (by hand) ────────

export interface StaleUnpaidOrder {
  id: string;
  grow_process_id: string | null;
}

/** Real orders still pending_payment (never paid) that were created more than
 *  `hours` ago — the hourly purge's candidates, oldest first. Test orders are
 *  never purged here (they are deleted only by hand). */
export async function listStaleUnpaidOrders(hours: number, limit = 200): Promise<StaleUnpaidOrder[]> {
  const r = await query<StaleUnpaidOrder>(
    `select id, grow_process_id from public.chip_orders
      where status = 'pending_payment' and paid_at is null and not is_test
        and created_at < now() - make_interval(hours => $1)
      order by created_at
      limit $2`,
    [hours, limit],
  );
  return r.rows;
}

export type OrderDeleteOutcome = 'deleted' | 'not_found' | 'file_failed';

/**
 * Deletes ONE order with its lease files: the files first, then the row (its
 * lines and notifications go with it — ON DELETE CASCADE; a chip issued for
 * one of its lines stays in the chips module, its order_item_id set NULL by
 * the FK). The row is locked for the whole operation and must still match:
 *   'unpaid' — a REAL order still pending_payment that was never paid. A paid
 *              order, in any status, is never deleted.
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
    const locked = await client.query(
      which === 'unpaid'
        ? `select id from public.chip_orders
            where id = $1 and status = 'pending_payment' and paid_at is null and not is_test
            for update`
        : `select id from public.chip_orders where id = $1 and is_test for update`,
      [id],
    );
    if ((locked.rowCount ?? 0) === 0) return 'not_found';
    const keys = (
      await client.query<{ k: string }>(
        `select lease_file_key as k from public.chip_order_items
          where order_id = $1 and lease_file_key is not null`,
        [id],
      )
    ).rows.map((r) => r.k);
    if (keys.length > 0 && !(await removeLeases(keys))) return 'file_failed';
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
