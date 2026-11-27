import 'server-only';
import { randomBytes } from 'node:crypto';
import type { PoolClient } from 'pg';
import { query, withTransaction } from '@/lib/db';
import { toPortalE164 } from '@/lib/portal/phone';
import { isSnapshotRole } from '@/lib/chips/holder';
import { writeAuditInTx } from '@/lib/db/audit';
import { issueChipGroupsInTx } from '@/lib/db/chips';
import { lockLeasesForAttach } from '@/lib/db/chipLeaseUploads';
import { enqueueDocumentInTx, releaseHeldInvoiceInTx } from '@/lib/db/chipOrderDocuments';
import { israelDate } from '@/lib/morning/documents';
import { priceLine } from '@/lib/chipOrders/model';
import {
  RECEPTION_MAX_PAID_CHIPS, composeReceptionAddress, receptionAmount, sameAmount,
  type ReceptionOrderer, type ReceptionPaymentMethod, type ReceptionRecordView,
} from '@/lib/chipOrders/reception';
import type { ChipWithHolder, IssueChipGroup, IssueChipsInput } from '@/lib/types/chips';

// Issuing a chip at the reception (25/11/2026) — the DB side of "הנפק צ׳יפ",
// the issue window opened with no order. The chips themselves are issued by
// the chips module (issueChipGroupsInTx: number collisions, holder identity,
// chip events) exactly as before; what is new sits AROUND that call, in the
// same transaction:
//   · cash or a bank transfer → a chip order (source 'reception') with one
//     apartment line and one holder line per block of the window, the chips
//     linked to both — as a web order is. It is born paid and ends the
//     transaction collected: the money is in and the chips are handed over.
//     Nobody is notified. Its Morning document is queued in the same
//     transaction (26/11/2026), with the real payment type;
//   · card (26/11/2026) → the card was charged FIRST, on a reception order
//     that waited for it (src/app/api/chips/reception/card); the save names
//     that order by its token and issues the chips onto it — only when the
//     charge is confirmed and it paid exactly these chips × the price;
//   · no charge → no order. A reception record keeps what the window
//     collected, and every chip of the save points at it.
// A save that issues no new chip (holder edits only) is not a payment and goes
// straight through.
//
// The audit rows of a save — `created` + `payment_recorded` for a reception
// order, `issued_no_charge` for a no-charge record — are written in the SAME
// transaction (writeAuditInTx): a recorded payment and its trail are one fact.

export type ReceptionErrorCode =
  /** New chips, and no payment method was chosen. */
  | 'payment_required'
  /** The amount the window showed is not the amount of this save any more. */
  | 'amount_mismatch'
  /** "מזומן או העברה" for a save that costs nothing. */
  | 'nothing_to_charge'
  /** More chips than one order line can hold. */
  | 'too_many_chips'
  /** An order needs a name of at least two letters. */
  | 'name_too_short'
  /** …and of no more than the order tables hold. */
  | 'name_too_long'
  /** The lease named by the save belongs to an order of the public page. */
  | 'lease_in_use'
  /** The lease named by the save is no longer in Storage: it was uploaded more
   *  than 24 hours ago, never saved, and the purge deleted it. */
  | 'lease_missing'
  /** "מזומן או העברה" for the extra chips of a TEST order: a test order records
   *  no payment and makes no real order. */
  | 'test_order_payment'
  /** "אשראי": the window's card payment is not (or no longer) a paid reception
   *  order waiting for its chips. */
  | 'card_not_paid'
  /** "אשראי": the card paid for another apartment, another number of chips, or
   *  another amount than this save. */
  | 'card_amount_mismatch'
  /** "אשראי" in the reception's sandbox TEST mode: a test payment never issues
   *  chips (it ends at the payment; it is refunded with "בטל הזמנת קבלה"). */
  | 'test_card_payment';

/** The longest name an order and its holder lines store. */
const ORDER_NAME_MAX = 120;

export class ReceptionError extends Error {
  constructor(readonly code: ReceptionErrorCode, readonly expectedAmount: number | null = null) {
    super(code);
    this.name = 'ReceptionError';
  }
}

export interface ReceptionSaveInput {
  orderer: ReceptionOrderer;
  /** How the NEW chips of this save are settled; null = nothing was chosen.
   *  'card' names the reception order its payment paid (card_token). */
  payment: { method: ReceptionPaymentMethod; amount: number; card_token?: string } | null;
}

export interface ReceptionSaveResult {
  items: ChipWithHolder[];
  updated: ChipWithHolder[];
  /** A payment was recorded: the reception order it made (or, for a card, the
   *  order the card paid). */
  order: { id: string; order_number: number; total: number; chips: number; unit_price: number; method: 'cash' | 'bank_transfer' | 'card' } | null;
  /** Chips were issued with no charge: the record that keeps their details. */
  record: { id: string; chips: number; unit_price: number } | null;
}

interface RegistryContact {
  id: string;
  apartment_number: string;
  owner_name: string | null;
  owner_phone: string | null;
  tenant_name: string | null;
  tenant_phone: string | null;
  operator_name: string | null;
  operator_phone: string | null;
}

/** The name and phone a group's chips will carry — the chips module's own
 *  rule: a registry role falls back to the live registry values, a snapshot
 *  role brings its own name. */
function holderOf(g: IssueChipGroup, contact: RegistryContact): { name: string; phone: string | null } {
  let name = g.holder_name?.trim() || null;
  let phone = g.holder_phone?.trim() || null;
  const role = g.resident_role;
  if (isSnapshotRole(role)) {
    if (!name) throw new Error('holder_name_required');
  } else {
    name = name ?? (contact[`${role}_name`]?.trim() || null);
    phone = phone ?? (contact[`${role}_phone`]?.trim() || null);
    if (!name) throw new Error('holder_not_in_registry');
  }
  return { name, phone };
}

/** A phone as the order tables keep it: E.164 for an Israeli mobile (what a
 *  web order stores), otherwise as the window normalised it. A value the
 *  tables would refuse (a registry phone of a few digits) is left out — the
 *  phone is optional here, and a save must not fail on it. */
function storedPhone(p: string | null | undefined): string | null {
  const raw = p?.trim();
  if (!raw) return null;
  const phone = toPortalE164(raw) ?? raw;
  return phone.length >= 5 && phone.length <= 32 ? phone : null;
}

/** A lease a save names must be one the reception itself uploaded: a key that
 *  sits on a line of an order of the public page is that order's file (it is
 *  deleted with a test order, and every open of it is logged under that
 *  order) and may not be tied to a chip from here. */
async function assertLeasesFree(client: PoolClient, input: IssueChipsInput): Promise<void> {
  const keys = [...new Set([
    ...input.groups.map((g) => g.lease?.key),
    ...(input.updates ?? []).map((u) => u.lease?.key),
  ].filter((k): k is string => !!k))];
  if (keys.length === 0) return;
  const taken = await client.query(
    `select 1 from public.chip_order_items where lease_file_key = any($1::text[])
     union all
     select 1 from public.chip_order_holders where lease_file_key = any($1::text[])
     limit 1`,
    [keys],
  );
  if ((taken.rowCount ?? 0) > 0) throw new ReceptionError('lease_in_use');
  // …and one whose file is still there. The rows of the named files stay
  // locked until this save commits, so the hourly purge of unsaved leases
  // cannot delete a file the save is attaching (chipLeaseUploads.ts).
  const gone = await lockLeasesForAttach(client, keys);
  if (gone.length > 0) throw new ReceptionError('lease_missing');
}

/**
 * "שמור שינויים" of the issue window without an order. ONE transaction,
 * all-or-nothing. `unitPrice` is the price per chip of /settings, read by the
 * caller right before — never a value of the request.
 */
export async function saveReceptionWindow(
  input: IssueChipsInput,
  reception: ReceptionSaveInput,
  unitPrice: number,
  actor: { id: string; name: string },
): Promise<ReceptionSaveResult> {
  return withTransaction(async (client) => {
    await assertLeasesFree(client, input);
    // The NEW chips of this save that no order line pays for. (A group that
    // names an order line is the old order flow; it settles nothing here.)
    const mine = input.groups
      .map((group, index) => ({ group, index, count: group.order_item_id ? 0 : group.numbers.filter((n) => n.trim() !== '').length }))
      .filter((x) => x.count > 0);
    const newChips = mine.reduce((sum, x) => sum + x.count, 0);
    if (newChips === 0) {
      const r = await issueChipGroupsInTx(client, input, actor);
      return { ...r, order: null, record: null };
    }

    const payment = reception.payment;
    if (!payment) throw new ReceptionError('payment_required');
    const expected = receptionAmount(newChips, unitPrice);

    const contact = (
      await client.query<RegistryContact>(
        `select id, apartment_number, owner_name, owner_phone, tenant_name, tenant_phone, operator_name, operator_phone
           from public.contacts where id = $1 for update`,
        [input.contact_id],
      )
    ).rows[0];
    if (!contact) throw new Error('contact_not_found');

    // One person per BLOCK of the window (a block with cards and app chips
    // arrives as two groups). The block number alone is the caller's word:
    // two groups are one person only when they also name the same role, name
    // and phone — otherwise each stands as a person of its own, checked and
    // stored under its own name.
    const blocks: { key: string; group: IssueChipGroup; indexes: number[]; count: number }[] = [];
    for (const { group, index, count } of mine) {
      const key = typeof group.block === 'number'
        ? JSON.stringify([group.block, group.resident_role, group.holder_name?.trim() ?? '', group.holder_phone?.trim() ?? ''])
        : `g${index}`;
      let block = blocks.find((b) => b.key === key);
      if (!block) {
        block = { key, group, indexes: [], count: 0 };
        blocks.push(block);
      }
      block.indexes.push(index);
      block.count += count;
    }

    const links = new Map<number, Partial<IssueChipGroup>>();
    let order: ReceptionSaveResult['order'] = null;
    let record: ReceptionSaveResult['record'] = null;
    const o = reception.orderer;

    if (payment.method === 'cash' || payment.method === 'bank_transfer' || payment.method === 'card') {
      if (expected <= 0) throw new ReceptionError('nothing_to_charge');
      // A card payment is checked against what the card actually paid (below):
      // a price changed in /settings after the charge must not strand the chips.
      if (payment.method !== 'card' && !sameAmount(payment.amount, expected)) throw new ReceptionError('amount_mismatch', expected);
      if (newChips > RECEPTION_MAX_PAID_CHIPS) throw new ReceptionError('too_many_chips');

      const people = blocks.map((b) => ({ ...b, ...holderOf(b.group, contact) }));
      const first = people[0]!;
      // The orderer defaults to the first chip holder of the save.
      const fullName = o.name?.trim() || first.name;
      if (fullName.length < 2 || people.some((p) => p.name.length < 2)) throw new ReceptionError('name_too_short');
      if (fullName.length > ORDER_NAME_MAX || people.some((p) => p.name.length > ORDER_NAME_MAX)) throw new ReceptionError('name_too_long');
      const price = priceLine(newChips, { unitPrice });
      // What this save settles: the /settings price, or — for a card — the paid order's own.
      let settled = { total: price.lineTotal, unitPrice };

      let orderId: string;
      let orderNumber: number;
      let itemId: string;
      if (payment.method === 'card') {
        // The order the window's card payment paid: a reception order, paid by
        // card (the processor confirmed it), still waiting for its chips — for
        // THIS apartment, THESE chips, THIS amount.
        const paid = payment.card_token && /^[A-Za-z0-9_-]{32,64}$/.test(payment.card_token)
          ? (
            await client.query<{
              id: string; order_number: number; total: number; status: string; source: string; payment_method: string | null;
              card_status: string | null; is_test: boolean; undoing: boolean;
            }>(
              `select id, order_number, total::float8 as total, status, source, payment_method, card_status, is_test,
                      (refunded_at is not null or refund_requested_at is not null or cancel_requested_at is not null) as undoing
                 from public.chip_orders where tracking_token = $1 for update`,
              [payment.card_token],
            )
          ).rows[0]
          : undefined;
        // (27/11/2026) An order "ביטול וזיכוי" was started on — or refunded —
        // while this window stayed open takes no chips.
        if (!paid || paid.source !== 'reception' || paid.payment_method !== 'card' || paid.card_status !== 'paid' || paid.status !== 'paid' || paid.undoing) {
          throw new ReceptionError('card_not_paid');
        }
        if (paid.is_test) throw new ReceptionError('test_card_payment');
        const line = (
          await client.query<{ id: string; contact_id: string; chips_count: number; unit_price: number }>(
            `select id, contact_id, chips_count, unit_price::float8 as unit_price from public.chip_order_items where order_id = $1`,
            [paid.id],
          )
        ).rows;
        if (line.length !== 1 || line[0].contact_id !== contact.id || line[0].chips_count !== newChips || !sameAmount(paid.total, payment.amount)) {
          throw new ReceptionError('card_amount_mismatch', paid.total);
        }
        settled = { total: paid.total, unitPrice: line[0].unit_price };
        const holdersAlready = (await client.query(`select 1 from public.chip_order_holders where order_id = $1 limit 1`, [paid.id])).rowCount ?? 0;
        if (holdersAlready > 0) throw new ReceptionError('card_not_paid');
        // The orderer's details as the window holds them at the save.
        await client.query(
          `update public.chip_orders
              set full_name = $2, phone_e164 = $3, email = $4, address = $5, address_street = $6, address_city = $7,
                  address_zip = $8, role = $9, internal_note = coalesce($10, internal_note), updated_at = now()
            where id = $1`,
          [
            paid.id, fullName, storedPhone(o.phone), o.email?.trim() || null, composeReceptionAddress(o)?.slice(0, 300) ?? null,
            o.street?.trim() || null, o.city?.trim() || null, o.zip?.trim() || null, first.group.resident_role,
            input.notes?.trim() || null,
          ],
        );
        // The invoice of the charge waited for these details (the email
        // Morning sends it to — 27/11/2026): it is due now.
        await releaseHeldInvoiceInTx(client, paid.id);
        orderId = paid.id;
        orderNumber = paid.order_number;
        itemId = line[0].id;
      } else {
        const created = (
          await client.query<{ id: string; order_number: number }>(
            `insert into public.chip_orders
               (source, status, full_name, phone_e164, email, address, address_street, address_city, address_zip, role, total,
                tracking_token, paid_at, payment_method, payment_recorded_by, payment_recorded_by_name, payment_recorded_at,
                internal_note)
             values ('reception', 'paid', $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, now(), $14, $11, $12, now(), $13)
             returning id, order_number`,
            [
              // (The one-line address is a convenience of the order — 300 characters at most; the parts keep everything.)
              fullName, storedPhone(o.phone), o.email?.trim() || null, composeReceptionAddress(o)?.slice(0, 300) ?? null,
              o.street?.trim() || null, o.city?.trim() || null, o.zip?.trim() || null,
              first.group.resident_role, price.lineTotal, randomBytes(32).toString('base64url'),
              actor.id, actor.name, input.notes?.trim() || null, payment.method,
            ],
          )
        ).rows[0]!;
        const item = (
          await client.query<{ id: string }>(
            `insert into public.chip_order_items
               (order_id, contact_id, apartment_number, chips_count, unit_price, threshold, price_above, line_total, match_status)
             values ($1, $2, $3, $4, $5, $6, $7, $8, $9)
             returning id`,
            [
              created.id, contact.id, contact.apartment_number, newChips,
              price.unitPrice, price.threshold, price.priceAbove, price.lineTotal,
              // The staff saw the person: an owner is the registry's owner, a
              // renter or an operator stands on a document, as on a web order.
              first.group.resident_role === 'owner' ? 'matched' : 'document_review',
            ],
          )
        ).rows[0]!;
        orderId = created.id;
        orderNumber = created.order_number;
        itemId = item.id;
        // Its Morning document, queued with the payment (a reception order is
        // never a test order when paid in cash or by transfer).
        await enqueueDocumentInTx(client, {
          orderId: created.id,
          kind: 'invoice',
          paymentKey: `reception:${created.id}`,
          amount: price.lineTotal,
          method: payment.method,
          details: { date: israelDate(), recorded_by: actor.name },
        });
      }
      for (const [position, p] of people.entries()) {
        // The lease itself stays on the person's chips (one stored object may
        // sit on several chips, and on a later order of the same person); the
        // holder line keeps the end date, and the order's window reads the
        // file from the chips.
        const holder = (
          await client.query<{ id: string }>(
            `insert into public.chip_order_holders
               (order_id, item_id, position, source, role, full_name, phone, email, chips_count, lease_end_date)
             values ($1, $2, $3, 'reception', $4, $5, $6, $7, $8, $9)
             returning id`,
            [
              orderId, itemId, position, p.group.resident_role, p.name, storedPhone(p.phone),
              p.group.holder_email?.trim() || null, p.count, p.group.lease_end_date ?? null,
            ],
          )
        ).rows[0]!;
        for (const index of p.indexes) links.set(index, { order_item_id: itemId, order_holder_id: holder.id });
      }
      order = { id: orderId, order_number: orderNumber, total: settled.total, chips: newChips, unit_price: settled.unitPrice, method: payment.method };
    } else {
      // Only "ללא חיוב" lands here. Any other word (an old 'cash_transfer' from a
      // direct caller) is refused rather than recorded as a free issue.
      if (payment.method !== 'none') throw new ReceptionError('payment_required');
      const created = (
        await client.query<{ id: string }>(
          `insert into public.chip_reception_records
             (contact_id, apartment_number, orderer_name, orderer_phone, orderer_email, address_street, address_city, address_zip,
              chips_count, unit_price, created_by, created_by_name)
           values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
           returning id`,
          [
            contact.id, contact.apartment_number, o.name?.trim() || null, storedPhone(o.phone), o.email?.trim() || null,
            o.street?.trim() || null, o.city?.trim() || null, o.zip?.trim() || null,
            newChips, unitPrice, actor.id, actor.name,
          ],
        )
      ).rows[0]!;
      for (const { index } of mine) links.set(index, { reception_record_id: created.id });
      record = { id: created.id, chips: newChips, unit_price: unitPrice };
    }

    const issued = await issueChipGroupsInTx(
      client,
      { ...input, groups: input.groups.map((g, i) => (links.has(i) ? { ...g, ...links.get(i) } : g)) },
      actor,
    );

    // The trail, in this same transaction. No person's name in it: the order /
    // the record holds those.
    const trail = { source: 'reception', contact_id: contact.id, apartment_number: contact.apartment_number, chips: newChips, unit_price: unitPrice };
    if (order) {
      // Paid and handed over on the spot: the order ends the save collected.
      await client.query(
        `update public.chip_orders
            set status = 'collected', ready_at = now(), collected_at = now(), updated_at = now()
          where id = $1`,
        [order.id],
      );
      const metadata = { ...trail, order_number: order.order_number };
      await writeAuditInTx(client, { actorUserId: actor.id, action: 'created', entityType: 'chip_order', entityId: order.id, metadata });
      await writeAuditInTx(client, {
        actorUserId: actor.id,
        action: 'payment_recorded',
        entityType: 'chip_order',
        entityId: order.id,
        metadata: { ...metadata, method: order.method, amount: order.total },
      });
    } else if (record) {
      await writeAuditInTx(client, {
        actorUserId: actor.id,
        action: 'issued_no_charge',
        entityType: 'chip_reception_record',
        entityId: record.id,
        metadata: { ...trail, method: 'none', amount: 0 },
      });
    }
    return { ...issued, order, record };
  });
}

/** The reception saves an apartment's chips came from — its no-charge records
 *  and its reception orders, newest first. A chip finds its own by
 *  reception_record_id / order_item_id (`ref`). */
export async function listReceptionRecords(contactId: string): Promise<ReceptionRecordView[]> {
  const r = await query<ReceptionRecordView>(
    `select 'record' as kind, r.id as ref, null::integer as order_number, r.created_at,
            r.orderer_name, r.orderer_phone, r.orderer_email,
            nullif(concat_ws(', ', r.address_street, nullif(concat_ws(' ', r.address_city, r.address_zip), '')), '') as address,
            r.chips_count, 0::float8 as amount, r.created_by_name as by_name, false as cancelled,
            null::text as payment_method, null::uuid as order_id, null::text as cancel_failed_step, null::text as cancel_error
       from public.chip_reception_records r
      where r.contact_id = $1
     union all
     select 'order' as kind, i.id as ref, o.order_number, o.created_at,
            o.full_name, o.phone_e164, o.email, o.address,
            i.chips_count, i.line_total::float8 as amount, o.payment_recorded_by_name as by_name,
            (o.status = 'rejected') as cancelled, o.payment_method, o.id as order_id,
            o.cancel_failed_step, o.cancel_error
       from public.chip_order_items i
       join public.chip_orders o on o.id = i.order_id
      -- A card payment that was never completed is not a save of the window.
      where i.contact_id = $1 and o.source = 'reception' and o.status <> 'pending_payment'
      order by created_at desc`,
    [contactId],
  );
  return r.rows;
}

// ── "אשראי" at the reception (26/11/2026) ──────────────────────────────────

export interface ReceptionCardOrderInput {
  contactId: string;
  newChips: number;
  unitPrice: number;
  /** The sandbox test mode of the reception card: a TEST order. */
  isTest: boolean;
  orderer: ReceptionOrderer;
  /** The role of the first chip holder of the window (the order's role). */
  role: string;
}

/**
 * The reception order a card payment of the issue window pays: born
 * pending_payment, payment_method 'card', with ONE apartment line of exactly
 * the new chips × the price of the settings (the amount PayPlus will charge).
 * No holder line and no chip yet — the save that follows the payment issues
 * them onto it (saveReceptionWindow, method 'card'). Recorded as "who started
 * the payment" (the reception rule: who and when). An order that is never
 * paid is purged with the unpaid web orders (after PayPlus is asked).
 */
export async function createReceptionCardOrder(
  input: ReceptionCardOrderInput,
  actor: { id: string; name: string },
): Promise<{ id: string; order_number: number; tracking_token: string; total: number }> {
  if (!Number.isInteger(input.newChips) || input.newChips < 1) throw new ReceptionError('nothing_to_charge');
  if (input.newChips > RECEPTION_MAX_PAID_CHIPS) throw new ReceptionError('too_many_chips');
  const name = input.orderer.name?.trim() ?? '';
  if (name.length < 2) throw new ReceptionError('name_too_short');
  if (name.length > ORDER_NAME_MAX) throw new ReceptionError('name_too_long');
  const price = priceLine(input.newChips, { unitPrice: input.unitPrice });
  if (price.lineTotal <= 0) throw new ReceptionError('nothing_to_charge');
  const role = ['owner', 'tenant', 'operator', 'other', 'staff'].includes(input.role) ? input.role : 'other';
  return withTransaction(async (client) => {
    const contact = (
      await client.query<{ id: string; apartment_number: string }>(
        `select id, apartment_number from public.contacts where id = $1`,
        [input.contactId],
      )
    ).rows[0];
    if (!contact) throw new Error('contact_not_found');
    const token = randomBytes(32).toString('base64url');
    const o = input.orderer;
    const created = (
      await client.query<{ id: string; order_number: number }>(
        `insert into public.chip_orders
           (source, status, is_test, full_name, phone_e164, email, address, address_street, address_city, address_zip, role,
            total, tracking_token, payment_method, payment_recorded_by, payment_recorded_by_name, payment_recorded_at)
         values ('reception', 'pending_payment', $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, 'card', $12, $13, now())
         returning id, order_number`,
        [
          input.isTest, name, storedPhone(o.phone), o.email?.trim() || null, composeReceptionAddress(o)?.slice(0, 300) ?? null,
          o.street?.trim() || null, o.city?.trim() || null, o.zip?.trim() || null, role,
          price.lineTotal, token, actor.id, actor.name,
        ],
      )
    ).rows[0]!;
    await client.query(
      `insert into public.chip_order_items
         (order_id, contact_id, apartment_number, chips_count, unit_price, threshold, price_above, line_total, match_status)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [
        created.id, contact.id, contact.apartment_number, input.newChips,
        price.unitPrice, price.threshold, price.priceAbove, price.lineTotal,
        role === 'owner' ? 'matched' : 'document_review',
      ],
    );
    await writeAuditInTx(client, {
      actorUserId: actor.id,
      action: 'card_payment_started',
      entityType: 'chip_order',
      entityId: created.id,
      metadata: { source: 'reception', order_number: created.order_number, chips: input.newChips, amount: price.lineTotal, test: input.isTest },
    });
    return { id: created.id, order_number: created.order_number, tracking_token: token, total: price.lineTotal };
  });
}
