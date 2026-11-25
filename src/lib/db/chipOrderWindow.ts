import 'server-only';
import { randomBytes } from 'node:crypto';
import type { PoolClient } from 'pg';
import { query, queryOne, withTransaction } from '@/lib/db';
import { toPortalE164 } from '@/lib/portal/phone';
import { validatePhone } from '@/lib/validation';
import {
  isOpenChipOrder, priceLine,
  type ChipOrderExtraOrder, type ChipOrderStatus, type ChipOrderWindow, type ChipOrderWindowChip, type ChipOrderWindowHolder,
  type ChipOrderWindowItem, type ChipOrderWindowOrder,
} from '@/lib/chipOrders/model';
import { RECEPTION_MAX_PAID_CHIPS, receptionAmount, sameAmount, type ReceptionPaymentMethod } from '@/lib/chipOrders/reception';
import { MAX_CHIPS_PER_GROUP } from '@/lib/chips/issueGroups';
import { writeAuditInTx } from '@/lib/db/audit';
import { issueChipGroupsInTx, ChipNumberTakenError } from '@/lib/db/chips';
import { ChipOrderStateError } from '@/lib/db/chipOrders';
import { ReceptionError } from '@/lib/db/chipReception';
import type { ChipHolderUpdate, ChipResidentRole, ChipType, IssueChipGroup } from '@/lib/types/chips';

// The issue window of a chip order (20/11/2026 design): one block per PERSON
// of the order (chip_order_holders), the order's transaction details, and one
// save for everything — holder edits, new chip numbers for any apartment of the
// order, the internal note — in ONE transaction. Chips are issued through the
// chips module's own issueChipGroupsInTx (soft limit, number collisions, chip
// events), one call per apartment, each chip linked to its order line AND its
// holder line.

interface ChipRow extends ChipOrderWindowChip {
  live_phone: string | null;
  issued_at: string;
  /** A lease attached in the issue window (a reception order keeps the file
   *  on the person's chips, not on the holder line). */
  lease_file_key: string | null;
  lease_file_name: string | null;
  lease_end_date: string | null;
}

const e164 = (p: string | null | undefined): string | null => (p ? toPortalE164(p) : null);

/** Everything the window shows for the order of one Orders-tab row. Null when
 *  the line does not exist or its order was never paid. */
export async function getChipOrderWindow(itemId: string): Promise<ChipOrderWindow | null> {
  const order = await queryOne<ChipOrderWindowOrder>(
    `select o.id, o.order_number, o.status, o.role, o.source, o.is_test, o.phone_verified, o.full_name, o.phone_e164, o.email,
            o.address, o.total::float8 as total, o.paid_at, o.due_at, o.created_at, o.internal_note,
            o.payment_method, o.payment_recorded_by_name, o.payment_recorded_at,
            o.collected_at, o.collected_by_name, o.handed_over_by_name, o.handed_over_via,
            o.rejected_at, o.reject_reason, o.cancelled_by_name,
            (select x.order_number from public.chip_orders x where x.id = o.extra_of_order_id) as extra_of_order_number
       from public.chip_order_items i
       join public.chip_orders o on o.id = i.order_id
      where i.id = $1 and o.status <> 'pending_payment'`,
    [itemId],
  );
  if (!order) return null;
  const items = (
    await query<ChipOrderWindowItem>(
      `select i.id, i.contact_id, i.apartment_number, i.chips_count, i.unit_price::float8 as unit_price, i.threshold,
              i.price_above::float8 as price_above, i.line_total::float8 as line_total,
              i.lease_file_key, i.lease_file_name, to_char(i.lease_end_date, 'YYYY-MM-DD') as lease_end_date,
              (select count(*)::int from public.chips c where c.order_item_id = i.id and c.status = 'active') as chips_linked
         from public.chip_order_items i
        where i.order_id = $1
        order by (select min(h.position) from public.chip_order_holders h where h.item_id = i.id) nulls last,
                 i.created_at,
                 nullif(regexp_replace(i.apartment_number, '\\D', '', 'g'), '')::numeric nulls last,
                 i.apartment_number`,
      [order.id],
    )
  ).rows;
  const holderRows = (
    await query<Omit<ChipOrderWindowHolder, 'chips' | 'existing' | 'extras'> & { source: 'order' | 'reception' | 'staff' }>(
      `select h.id, h.item_id, h.source, h.role, h.full_name, h.phone, h.email, h.chips_count,
              h.lease_file_key, h.lease_file_name, to_char(h.lease_end_date, 'YYYY-MM-DD') as lease_end_date
         from public.chip_order_holders h
        where h.order_id = $1
        order by h.position, h.created_at, h.id`,
      [order.id],
    )
  ).rows;
  const chips = (
    await query<ChipRow>(
      `select ch.id, ch.chip_number, ch.chip_type, ch.status, ch.contact_id, ch.order_item_id, ch.order_holder_id,
              ch.resident_role, ch.holder_name, ch.holder_phone, ch.issued_at,
              ch.lease_file_key, ch.lease_file_name, to_char(ch.lease_end_date, 'YYYY-MM-DD') as lease_end_date,
              case ch.resident_role when 'owner' then c.owner_phone when 'tenant' then c.tenant_phone
                                    when 'operator' then c.operator_phone else null end as live_phone
         from public.chips ch
         left join public.contacts c on c.id = ch.contact_id
        where ch.contact_id = any($1::uuid[])
        order by ch.issued_at, ch.chip_number, ch.id`,
      [items.map((i) => i.contact_id)],
    )
  ).rows;

  // Extra chips of this order that were paid at the reception: they sit on a
  // reception order of their own, whose holder lines point back at the person
  // of THIS order they were added for.
  const extraLines = holderRows.length === 0 ? [] : (
    await query<{ id: string; extra_of_holder_id: string }>(
      `select e.id, e.extra_of_holder_id from public.chip_order_holders e where e.extra_of_holder_id = any($1::uuid[])`,
      [holderRows.map((h) => h.id)],
    )
  ).rows;
  const extraOf = new Map(extraLines.map((e) => [e.id, e.extra_of_holder_id]));
  const extra_orders = (
    await query<ChipOrderExtraOrder>(
      `select x.order_number, x.status, x.total::float8 as total,
              (select coalesce(sum(i.chips_count), 0)::int from public.chip_order_items i where i.order_id = x.id) as chips_count
         from public.chip_orders x
        where x.extra_of_order_id = $1
        order by x.created_at, x.order_number`,
      [order.id],
    )
  ).rows;

  const itemIds = new Set(items.map((i) => i.id));
  const strip = (c: ChipRow): ChipOrderWindowChip => ({
    id: c.id, chip_number: c.chip_number, chip_type: c.chip_type, status: c.status, contact_id: c.contact_id,
    order_item_id: c.order_item_id, order_holder_id: c.order_holder_id, resident_role: c.resident_role,
    holder_name: c.holder_name, holder_phone: c.holder_phone,
  });

  const holders: ChipOrderWindowHolder[] = [];
  for (const item of items) {
    const own = holderRows.filter((h) => h.item_id === item.id);
    const blocks: ChipOrderWindowHolder[] = own.length > 0
      ? own.map((h) => ({ ...h, chips: [], existing: [], extras: [] }))
      : [{
          // An order from before 20/11/2026: one block for the apartment, from
          // the order's own name and phone.
          id: null, item_id: item.id, source: 'legacy', role: order.role, full_name: order.full_name,
          phone: order.phone_e164, email: order.email, chips_count: item.chips_count,
          lease_file_key: item.lease_file_key, lease_file_name: item.lease_file_name, lease_end_date: item.lease_end_date,
          chips: [], existing: [], extras: [],
        }];
    for (const c of chips) {
      if (c.contact_id !== item.contact_id) continue;
      const byHolder = c.order_holder_id ? blocks.find((b) => b.id === c.order_holder_id) : undefined;
      if (byHolder) {
        byHolder.chips.push(strip(c));
        // A reception order: the person's lease is on the chips.
        if (!byHolder.lease_file_key && c.lease_file_key) {
          byHolder.lease_file_key = c.lease_file_key;
          byHolder.lease_file_name = c.lease_file_name;
          byHolder.lease_end_date = byHolder.lease_end_date ?? c.lease_end_date;
        }
      } else if (!c.order_holder_id && c.order_item_id === item.id) blocks[0].chips.push(strip(c));
      else if (c.order_holder_id && extraOf.has(c.order_holder_id)) {
        blocks.find((b) => b.id === extraOf.get(c.order_holder_id as string))?.extras.push(strip(c));
      }
    }
    holders.push(...blocks);
  }
  // The same person's earlier chips in the apartment — matched by phone
  // (05…, 9725…, +9725… are one number), each chip to one block at most.
  const claimed = new Set(holders.flatMap((h) => [...h.chips, ...h.extras].map((c) => c.id)));
  for (const h of holders) {
    const phone = e164(h.phone);
    if (!phone) continue;
    const contactId = items.find((i) => i.id === h.item_id)?.contact_id;
    for (const c of chips) {
      if (claimed.has(c.id) || c.contact_id !== contactId || c.order_holder_id) continue;
      if (c.order_item_id && itemIds.has(c.order_item_id)) continue;
      if (e164(c.holder_phone ?? c.live_phone) !== phone) continue;
      h.existing.push(strip(c));
      claimed.add(c.id);
    }
  }
  const clicked = items.find((i) => i.id === itemId) ?? items[0];
  return {
    order,
    items,
    holders,
    clicked_item_id: clicked.id,
    order_all_linked: items.every((i) => i.chips_linked >= i.chips_count),
    extra_orders,
  };
}

// ── Save ─────────────────────────────────────────────────────────────────

export interface WindowSaveHolder {
  /** An existing holder line, or null: a new staff holder / the first save of
   *  a legacy block. */
  id: string | null;
  item_id: string;
  /** The block of an order from before 20/11/2026 (stored as a holder line now). */
  legacy?: boolean;
  role: ChipResidentRole;
  full_name: string;
  phone: string | null;
  email: string | null;
  new_chips: { number: string; chip_type: ChipType }[];
}

export interface WindowSaveInput {
  holders: WindowSaveHolder[];
  /** Staff holders to remove — only a 'staff' line with no chip (any status)
   *  linked to it; a person of the order (paid) is never removed. */
  removedHolderIds?: string[];
  /** undefined = untouched. */
  note?: string | null;
  /** How the EXTRA chips of this save are settled — new numbers beyond what
   *  the apartment line paid for online. Required when the save has any;
   *  ignored when it has none. The amount is what the window showed. */
  extraPayment?: { method: ReceptionPaymentMethod; amount: number } | null;
}

export interface WindowSaveResult {
  issued: number;
  updated: number;
  /** The extra chips of the save: how many, how they were settled, and the
   *  reception order a recorded payment made. Null = the save had none. */
  extra: { chips: number; method: ReceptionPaymentMethod; order: { order_number: number; total: number } | null } | null;
}

/** A number another chip holds — `holderIndex` is the block's index in the
 *  request, so the window can mark the right row. */
export class WindowChipConflictError extends Error {
  constructor(readonly chipNumber: string, readonly holderIndex: number | null) {
    super('chip_number_taken');
    this.name = 'WindowChipConflictError';
  }
}

export class WindowInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WindowInputError';
  }
}

interface HolderLineRow {
  id: string;
  item_id: string;
  role: ChipResidentRole;
  full_name: string;
  phone: string | null;
  email: string | null;
  /** What this person ordered online (0 on a holder the staff added). */
  chips_count: number;
}

function cleanPhone(raw: string | null, index: number): string | null {
  const p = raw?.trim() ?? '';
  if (!p) return null;
  const v = validatePhone(p);
  if (!v.valid) throw new WindowInputError(`${v.error ?? 'מספר טלפון לא תקין'} (בעל צ׳יפ ${index + 1})`);
  return e164(v.normalized) ?? v.normalized;
}

/**
 * "שמור שינויים" of the order window. One transaction:
 *   1. the order is locked and must still be open (paid / ready);
 *   2. every block: an existing holder line is updated (role, name, phone,
 *      email); a new staff holder or a legacy block becomes a holder line
 *      (staff: chips_count 0 — never part of the paid quantity or the total);
 *   3. per apartment, ONE issueChipGroupsInTx call issues the new numbers
 *      (linked to the order line and the holder line) and applies the holder's
 *      name / phone / role to the chips already linked to it;
 *   4. the internal note.
 *
 * EXTRA CHIPS (25/11/2026). An apartment line paid online for a quantity. A
 * new number that fits inside it — the line's active chips are still fewer
 * than what it ordered — is part of the order, as always. A new number beyond
 * it is an EXTRA chip, and the save must say how the extras are settled
 * (`extraPayment`), with the rules of issuing at the reception.
 * WHOSE chips are the extra ones: each person first takes what is left of the
 * quantity THEY ordered; room the line still has after that goes to the others
 * in the order of the blocks; whatever is left over is extra. So the person
 * who got more than they ordered is the one whose chip is extra — never a
 * neighbour who only got what they paid for.
 * The rules of the settlement:
 *   · cash or a transfer → a RECEPTION order of its own (already paid and
 *     collected, nobody notified) with one line per apartment and one holder
 *     line per person, linked back to this order (extra_of_order_id) and to
 *     the person the chips were added for (extra_of_holder_id). The extra
 *     chips belong to that order — cancelling it disables exactly them. The
 *     amount is extras × `unitPrice`; a save whose amount moved is refused;
 *   · no charge → no order: the extras are linked to this order's own line,
 *     as extra chips always were, and the save is audited.
 * A TEST order records no payment: its extras go with "ללא חיוב" only (a
 * reception order is never a test order, and would outlive the test).
 * A save that confirms a sum while there is nothing extra to pay for is
 * refused (amount_mismatch, expected 0) — never saved with the payment dropped.
 * The web order itself — its lines, its quantity, its total — never changes.
 * `unitPrice` is the price per chip of /settings, read by the caller right
 * before; never a value of the request. Returns null when the order does not
 * exist.
 */
export async function saveChipOrderWindow(
  orderId: string,
  input: WindowSaveInput,
  actor: { id: string; name: string },
  unitPrice: number,
): Promise<WindowSaveResult | null> {
  return withTransaction(async (client: PoolClient) => {
    const order = (
      await client.query<{
        status: ChipOrderStatus; order_number: number; is_test: boolean; role: ChipResidentRole; full_name: string; phone_e164: string | null;
        email: string | null; address: string | null; address_street: string | null; address_city: string | null; address_zip: string | null;
      }>(
        `select status, order_number, is_test, role, full_name, phone_e164, email, address, address_street, address_city, address_zip
           from public.chip_orders where id = $1 for update`,
        [orderId],
      )
    ).rows[0];
    if (!order) return null;
    if (!isOpenChipOrder(order.status)) throw new ChipOrderStateError('not_open');

    const items = (
      await client.query<{ id: string; contact_id: string; apartment_number: string; chips_count: number; match_status: string; linked: number }>(
        `select i.id, i.contact_id, i.apartment_number, i.chips_count, i.match_status,
                (select count(*)::int from public.chips c where c.order_item_id = i.id and c.status = 'active') as linked
           from public.chip_order_items i where i.order_id = $1`,
        [orderId],
      )
    ).rows;
    // What each apartment line may still take inside the quantity it paid for.
    const room = new Map(items.map((i) => [i.id, Math.max(0, i.chips_count - i.linked)]));
    const lines = new Map(
      (
        await client.query<HolderLineRow>(
          `select id, item_id, role, full_name, phone, email, chips_count from public.chip_order_holders where order_id = $1 for update`,
          [orderId],
        )
      ).rows.map((h) => [h.id, h]),
    );
    let nextPosition = (
      await client.query<{ n: number }>(
        `select coalesce(max(position), -1)::int + 1 as n from public.chip_order_holders where order_id = $1`,
        [orderId],
      )
    ).rows[0].n;

    for (const id of input.removedHolderIds ?? []) {
      const r = await client.query(
        `delete from public.chip_order_holders h
          where h.id = $1 and h.order_id = $2 and h.source = 'staff'
            and not exists (select 1 from public.chips c where c.order_holder_id = h.id)
            -- …nor paid extras: they sit on a reception order's holder line
            -- that points back at this one, and would lose their person.
            and not exists (select 1 from public.chip_order_holders e where e.extra_of_holder_id = h.id)`,
        [id, orderId],
      );
      if ((r.rowCount ?? 0) === 0) throw new WindowInputError('אפשר להסיר רק בעל צ׳יפ שנוסף בחלון ואין לו צ׳יפים');
      lines.delete(id);
    }

    type PerContact = { groups: IssueChipGroup[]; groupHolder: number[]; updates: ChipHolderUpdate[] };
    const byContact = new Map<string, PerContact>();
    const forContact = (contactId: string) => {
      let c = byContact.get(contactId);
      if (!c) { c = { groups: [], groupHolder: [], updates: [] }; byContact.set(contactId, c); }
      return c;
    };
    type NewChip = { number: string; chip_type: ChipType };
    type Who = { role: ChipResidentRole; name: string; chipPhone: string | null };
    /** New numbers of one person, per type, in groups the chips module accepts. */
    const pushGroups = (
      bucket: PerContact, holderIndex: number, who: Who, chips: NewChip[], link: { order_item_id: string; order_holder_id: string },
    ) => {
      for (const type of ['physical', 'app'] as const) {
        const nums = chips.filter((n) => n.chip_type === type).map((n) => n.number);
        for (let k = 0; k < nums.length; k += MAX_CHIPS_PER_GROUP) {
          bucket.groups.push({
            resident_role: who.role,
            holder_name: who.name,
            holder_phone: who.chipPhone,
            chip_type: type,
            numbers: nums.slice(k, k + MAX_CHIPS_PER_GROUP),
            ...link,
          });
          bucket.groupHolder.push(holderIndex);
        }
      }
    };
    /** The new numbers of one block of the save. */
    type Lot = {
      item: (typeof items)[number]; holderId: string; holderIndex: number; who: Who; phone: string | null; email: string | null; chips: NewChip[];
    };
    const lots: Lot[] = [];
    /** What each person may still take inside the quantity THEY ordered. */
    const ownRoom = new Map<string, number>();
    const seenHolder = new Set<string>();
    /** The extra chips of one person of the save — beyond what the line paid for. */
    const extraLots: Lot[] = [];

    for (const [index, h] of input.holders.entries()) {
      const item = items.find((i) => i.id === h.item_id);
      if (!item) throw new WindowInputError('order_item_not_in_order');
      const name = h.full_name.trim();
      const phone = cleanPhone(h.phone, index);
      const email = h.email?.trim() ? h.email.trim().toLowerCase() : null;
      if (name.length < 2) {
        if (h.id || h.new_chips.length > 0 || h.legacy) throw new WindowInputError(`נדרש שם מלא לבעל הצ׳יפ (בעל צ׳יפ ${index + 1})`);
        continue; // an empty new block — nothing to keep
      }

      let holderId: string;
      if (h.id) {
        const cur = lines.get(h.id);
        if (!cur || cur.item_id !== item.id) throw new WindowInputError('holder_not_in_order');
        holderId = h.id;
        if (cur.role !== h.role || cur.full_name !== name || cur.phone !== phone || (cur.email ?? null) !== email) {
          // The person's details — also on the holder lines of the reception
          // orders that hold this person's paid extras.
          await client.query(
            `update public.chip_order_holders set role = $2, full_name = $3, phone = $4, email = $5, updated_at = now()
              where id = $1 or extra_of_holder_id = $1`,
            [h.id, h.role, name, phone, email],
          );
        }
        if (!ownRoom.has(holderId)) ownRoom.set(holderId, cur.chips_count);
      } else {
        // A legacy block becomes the apartment's 'order' holder line (with the
        // paid quantity); anything else the staff added is a 'staff' holder.
        const legacy = h.legacy === true
          && (await client.query(`select 1 from public.chip_order_holders where item_id = $1 limit 1`, [item.id])).rowCount === 0;
        if (legacy && !phone) throw new WindowInputError(`נדרש טלפון לבעל הצ׳יפ (בעל צ׳יפ ${index + 1})`);
        holderId = (
          await client.query<{ id: string }>(
            `insert into public.chip_order_holders (order_id, item_id, position, source, role, full_name, phone, email, chips_count)
             values ($1,$2,$3,$4,$5,$6,$7,$8,$9) returning id`,
            [orderId, item.id, nextPosition++, legacy ? 'order' : 'staff', h.role, name, phone, email, legacy ? item.chips_count : 0],
          )
        ).rows[0].id;
        ownRoom.set(holderId, legacy ? item.chips_count : 0);
        if (legacy) {
          // The apartment's chips issued for the order before it had holder lines.
          await client.query(
            `update public.chips set order_holder_id = $1, updated_at = now()
              where order_item_id = $2 and order_holder_id is null`,
            [holderId, item.id],
          );
        }
      }

      const bucket = forContact(item.contact_id);
      const chipPhone = phone ? validatePhone(phone).normalized || phone : null;
      // The holder's name / phone / role reach the chips already linked to it —
      // its own, and the paid extras that were added for it (they sit on a
      // reception order's holder line that points back at this one).
      const linked = (
        await client.query<{
          id: string; holder_name: string | null; holder_phone: string | null; resident_role: ChipResidentRole; own_active: boolean;
        }>(
          `select c.id, c.holder_name, c.holder_phone, c.resident_role,
                  (c.order_holder_id = $1 and c.status = 'active') as own_active
             from public.chips c
            where c.order_holder_id = $1
               or c.order_holder_id in (select e.id from public.chip_order_holders e where e.extra_of_holder_id = $1)`,
          [holderId],
        )
      ).rows;
      if (!seenHolder.has(holderId)) {
        // What is left of the quantity this person ordered, once.
        seenHolder.add(holderId);
        ownRoom.set(holderId, Math.max(0, (ownRoom.get(holderId) ?? 0) - linked.filter((c) => c.own_active).length));
      }
      for (const c of linked) {
        const patch: ChipHolderUpdate = { id: c.id };
        if ((c.holder_name ?? null) !== name) patch.holder_name = name;
        if ((e164(c.holder_phone) ?? c.holder_phone ?? null) !== (e164(chipPhone) ?? chipPhone)) patch.holder_phone = chipPhone;
        if (c.resident_role !== h.role) patch.resident_role = h.role;
        if (Object.keys(patch).length > 1) bucket.updates.push(patch);
      }
      const fresh = h.new_chips.map((n) => ({ number: n.number.trim(), chip_type: n.chip_type })).filter((n) => n.number !== '');
      if (fresh.length > 0) {
        lots.push({ item, holderId, holderIndex: index, who: { role: h.role, name, chipPhone }, phone, email, chips: fresh });
      }
    }

    // ── Which of the new numbers are inside the paid quantity ──────────────
    // Each person first takes what is left of the quantity THEY ordered; room
    // the line still has after that goes to the others, in the order of the
    // blocks; the rest is extra. Per line the count is the same either way —
    // max(0, added − room) — this only decides WHOSE chips the extra ones are.
    const inside = lots.map(() => 0);
    for (const pass of ['own', 'rest'] as const) {
      for (const [k, lot] of lots.entries()) {
        const left = room.get(lot.item.id) ?? 0;
        const want = lot.chips.length - inside[k]!;
        const take = Math.min(left, pass === 'own' ? Math.min(want, ownRoom.get(lot.holderId) ?? 0) : want);
        if (take <= 0) continue;
        inside[k] = inside[k]! + take;
        room.set(lot.item.id, left - take);
        if (pass === 'own') ownRoom.set(lot.holderId, (ownRoom.get(lot.holderId) ?? 0) - take);
      }
    }
    for (const [k, lot] of lots.entries()) {
      const paid = inside[k]!;
      pushGroups(forContact(lot.item.contact_id), lot.holderIndex, lot.who, lot.chips.slice(0, paid), { order_item_id: lot.item.id, order_holder_id: lot.holderId });
      if (lot.chips.length > paid) extraLots.push({ ...lot, chips: lot.chips.slice(paid) });
    }

    // ── The extra chips of the save ────────────────────────────────────────
    const extraChips = extraLots.reduce((n, lot) => n + lot.chips.length, 0);
    let extra: WindowSaveResult['extra'] = null;
    let extraOrderId: string | null = null;
    if (extraChips === 0) {
      // The window confirmed a sum for extras that are not extras any more
      // (a chip of the line was disabled elsewhere meanwhile): refused, so the
      // window loads again — never saved with the payment silently dropped.
      const payment = input.extraPayment ?? null;
      if (payment?.method === 'cash_transfer' && payment.amount > 0) throw new ReceptionError('amount_mismatch', 0);
    } else {
      const payment = input.extraPayment ?? null;
      const expected = receptionAmount(extraChips, unitPrice);
      if (!payment) throw new ReceptionError('payment_required', expected);
      if (payment.method === 'cash_transfer') {
        // A test order records no payment, and makes no real order.
        if (order.is_test) throw new ReceptionError('test_order_payment');
        if (expected <= 0) throw new ReceptionError('nothing_to_charge');
        if (!sameAmount(payment.amount, expected)) throw new ReceptionError('amount_mismatch', expected);
        // One line of the reception order per apartment that got extras.
        const perItem = new Map<string, number>();
        for (const lot of extraLots) perItem.set(lot.item.id, (perItem.get(lot.item.id) ?? 0) + lot.chips.length);
        if ([...perItem.values()].some((n) => n > RECEPTION_MAX_PAID_CHIPS)) throw new ReceptionError('too_many_chips');

        const created = (
          await client.query<{ id: string; order_number: number }>(
            `insert into public.chip_orders
               (source, status, full_name, phone_e164, email, address, address_street, address_city, address_zip, role, total,
                tracking_token, paid_at, payment_method, payment_recorded_by, payment_recorded_by_name, payment_recorded_at,
                extra_of_order_id)
             values ('reception', 'paid', $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, now(), 'cash_transfer', $11, $12, now(), $13)
             returning id, order_number`,
            [
              // Whoever placed the web order is who these chips were added for.
              order.full_name, order.phone_e164, order.email, order.address,
              order.address_street, order.address_city, order.address_zip, order.role,
              expected, randomBytes(32).toString('base64url'), actor.id, actor.name, orderId,
            ],
          )
        ).rows[0]!;
        extraOrderId = created.id;
        const lineOf = new Map<string, string>();
        for (const [itemId, count] of perItem) {
          const webItem = items.find((i) => i.id === itemId)!;
          const price = priceLine(count, { unitPrice });
          const line = (
            await client.query<{ id: string }>(
              `insert into public.chip_order_items
                 (order_id, contact_id, apartment_number, chips_count, unit_price, threshold, price_above, line_total, match_status)
               values ($1, $2, $3, $4, $5, $6, $7, $8, $9)
               returning id`,
              [created.id, webItem.contact_id, webItem.apartment_number, count, price.unitPrice, price.threshold, price.priceAbove, price.lineTotal, webItem.match_status],
            )
          ).rows[0]!;
          lineOf.set(itemId, line.id);
        }
        for (const [position, lot] of extraLots.entries()) {
          const line = lineOf.get(lot.item.id)!;
          const holder = (
            await client.query<{ id: string }>(
              `insert into public.chip_order_holders
                 (order_id, item_id, position, source, role, full_name, phone, email, chips_count, extra_of_holder_id)
               values ($1, $2, $3, 'reception', $4, $5, $6, $7, $8, $9)
               returning id`,
              [created.id, line, position, lot.who.role, lot.who.name, lot.phone, lot.email, lot.chips.length, lot.holderId],
            )
          ).rows[0]!;
          // The extra chips belong to the reception order's line and person.
          pushGroups(forContact(lot.item.contact_id), lot.holderIndex, lot.who, lot.chips, { order_item_id: line, order_holder_id: holder.id });
        }
        extra = { chips: extraChips, method: 'cash_transfer', order: { order_number: created.order_number, total: expected } };
      } else {
        // No charge: no order. The extras stay on this order's own line.
        for (const lot of extraLots) {
          pushGroups(forContact(lot.item.contact_id), lot.holderIndex, lot.who, lot.chips, { order_item_id: lot.item.id, order_holder_id: lot.holderId });
        }
        extra = { chips: extraChips, method: 'none', order: null };
      }
    }

    let issued = 0;
    let updated = 0;
    for (const [contactId, b] of byContact) {
      if (b.groups.length === 0 && b.updates.length === 0) continue;
      try {
        const r = await issueChipGroupsInTx(
          client,
          {
            contact_id: contactId,
            groups: b.groups,
            updates: b.updates,
            notes: null,
          },
          actor,
        );
        issued += r.items.length;
        updated += r.updated.length;
      } catch (err) {
        if (err instanceof ChipNumberTakenError) {
          throw new WindowChipConflictError(err.chipNumber, err.groupIndex !== null ? b.groupHolder[err.groupIndex] ?? null : null);
        }
        throw err;
      }
    }

    // The trail of the extra chips, in this same transaction (as at the
    // reception): a recorded payment and its trail are one fact.
    if (extra) {
      const trail = { source: 'web_order_extra', extra_of_order: order.order_number, chips: extra.chips, unit_price: unitPrice };
      if (extra.order && extraOrderId) {
        // Paid and added on the spot: the reception order ends the save collected.
        await client.query(
          `update public.chip_orders
              set status = 'collected', ready_at = now(), collected_at = now(), updated_at = now()
            where id = $1`,
          [extraOrderId],
        );
        const metadata = { ...trail, order_number: extra.order.order_number };
        await writeAuditInTx(client, { actorUserId: actor.id, action: 'created', entityType: 'chip_order', entityId: extraOrderId, metadata });
        await writeAuditInTx(client, {
          actorUserId: actor.id,
          action: 'payment_recorded',
          entityType: 'chip_order',
          entityId: extraOrderId,
          metadata: { ...metadata, method: 'cash_transfer', amount: extra.order.total },
        });
      } else {
        await writeAuditInTx(client, {
          actorUserId: actor.id,
          action: 'extra_chips_no_charge',
          entityType: 'chip_order',
          entityId: orderId,
          metadata: { ...trail, order_number: order.order_number, method: 'none', amount: 0 },
        });
      }
    }

    if (input.note !== undefined) {
      await client.query(
        `update public.chip_orders set internal_note = $2, updated_at = now() where id = $1`,
        [orderId, input.note?.trim() ? input.note.trim() : null],
      );
    }
    return { issued, updated, extra };
  });
}

/** "מחק הזמנת בדיקה" (20/11/2026): the ACTIVE chips issued for a TEST order —
 *  disabled before the order is deleted. Empty for a real order. */
export async function listActiveChipIdsOfTestOrder(orderId: string): Promise<string[]> {
  const r = await query<{ id: string }>(
    `select c.id from public.chips c
       join public.chip_order_items i on i.id = c.order_item_id
       join public.chip_orders o on o.id = i.order_id
      where o.id = $1 and o.is_test and c.status = 'active'
      order by c.issued_at`,
    [orderId],
  );
  return r.rows.map((row) => row.id);
}
